const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DATA_DIR, allSettings } = require('./db');
const fal = require('./fal');
const img = require('./image');

const FILES = path.join(DATA_DIR, 'files');          // publiek (onraadbare namen)
const ORIGINALS = path.join(DATA_DIR, 'originals');  // niet publiek
fs.mkdirSync(ORIGINALS, { recursive: true });

const rid = () => crypto.randomBytes(16).toString('hex');

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('download mislukt ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Met klanttekst en een tekst-prompt -> die gebruiken ({{tekst}} wordt vervangen), anders de gewone prompt.
function promptFor(design, text) {
  const t = (text || '').trim();
  if (!t || !design.prompt_with_text) return design.prompt;
  const tpl = design.prompt_with_text;
  return tpl.includes('{{tekst}}') ? tpl.split('{{tekst}}').join(`"${t}"`) : `${tpl} Tekst: "${t}"`;
}

const FAL_RATIO = { tegel: '1:1', landscape: '3:2', portrait: '2:3' };

async function process_(job) {
  const settings = allSettings();
  const design = db.prepare('SELECT * FROM designs WHERE id=?').get(job.design_id);
  if (!design) throw new Error('Ontwerp bestaat niet meer');
  const target = img.targetSize(job.profile, job.orientation, settings);

  const original = fs.readFileSync(path.join(ORIGINALS, job.original_file));
  const prepared = await img.prepareInput(original, job.profile, job.orientation);

  let extra = {};
  try { extra = JSON.parse(design.extra_json || '{}'); } catch { /* negeren */ }
  const prompt = promptFor(design, job.custom_text);
  const input = {
    prompt,
    image_url: `data:image/jpeg;base64,${prepared.buffer.toString('base64')}`,
    num_images: 1,
    output_format: 'jpeg',
    aspect_ratio: job.profile === 'tegel' ? FAL_RATIO.tegel : FAL_RATIO[job.orientation],
    ...extra,
  };
  if (design.negative_prompt) input.negative_prompt = design.negative_prompt;

  const out = await fal.run(design.model, input);
  let url = fal.firstImageUrl(out);
  if (!url) throw new Error('Model gaf geen afbeelding terug');
  let buf = await download(url);

  // Upscale als het resultaat kleiner is dan het drukformaat.
  const meta = await require('sharp')(buf).metadata();
  const need = Math.max(target.w / meta.width, target.h / meta.height);
  if (need > 1.05 && settings.upscale_model) {
    const factor = Math.min(4, Math.max(2, Math.ceil(need)));
    const up = await fal.run(settings.upscale_model, { image_url: url, upscale_factor: factor });
    const upUrl = fal.firstImageUrl(up);
    if (upUrl) buf = await download(upUrl);
  }

  const { printBuf, previewBuf } = await img.finalize(buf, target);
  const base = rid();
  const printFile = `${base}-print.jpg`;
  const previewFile = `${base}-preview.jpg`;
  fs.writeFileSync(path.join(FILES, printFile), printBuf);
  fs.writeFileSync(path.join(FILES, previewFile), previewBuf);
  db.prepare(`UPDATE jobs SET status='done', preview_file=?, print_file=?, print_w=?, print_h=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(previewFile, printFile, target.w, target.h, job.id);
}

// Eenvoudige wachtrij: maximaal 3 tegelijk.
const queue = [];
let running = 0;
const MAX = 3;
function pump() {
  while (running < MAX && queue.length) {
    const id = queue.shift();
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job) continue;
    running++;
    db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
    process_(job)
      .catch((e) => {
        console.error('[job]', id, e.message);
        db.prepare("UPDATE jobs SET status='error', error=?, finished_at=CURRENT_TIMESTAMP WHERE id=?").run(String(e.message).slice(0, 500), id);
      })
      .finally(() => { running--; pump(); });
  }
}
function enqueue(id) { queue.push(id); pump(); }

// Bij herstart: jobs die nog liepen opnieuw in de wachtrij zetten.
function resume() {
  db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all().forEach((r) => enqueue(r.id));
}

module.exports = { promptFor, enqueue, resume, rid, FILES, ORIGINALS };
