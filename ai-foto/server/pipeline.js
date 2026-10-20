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

// Met klanttekst en een tekst-prompt -> die gebruiken ({{CUSTOM_TEXT}} wordt vervangen; {{tekst}} werkt ook), anders de gewone prompt.
function promptFor(design, text) {
  const t = (text || '').trim();
  if (!t || !design.prompt_with_text) return design.prompt;
  const tpl = design.prompt_with_text;
  const re = /\{\{?\s*(custom[ _-]?text|tekst)\s*\}?\}/gi;   // {{CUSTOM_TEXT}}, {custom text}, {tekst}, ...
  return re.test(tpl) ? tpl.replace(re, () => `"${t}"`) : `${tpl} Tekst: "${t}"`;
}

const FAL_RATIO = { tegel: '1:1', landscape: '3:2', portrait: '2:3' };

// Snel deel: alleen het AI-resultaat + voorbeeld. Vergroten/drukbestand gebeurt pas na de keuze (finalizeVariant).
// Controle: laat een goedkoop vision-model beoordelen of het resultaat hetzelfde onderwerp toont als de foto van de klant
// (bv. hond blijft hond, geen verzonnen personen). Bij twijfel of een fout in de controle: gewoon doorlaten.
async function subjectMatches(photoDataUrl, resultBuf, settings) {
  try {
    const out = await fal.run('fal-ai/any-llm/vision', {
      model: settings.controle_model || 'google/gemini-2.0-flash-001',
      prompt: 'Image 1 is a customer photo. Image 2 is an AI-made drawing/artwork based on it. Does image 2 show the SAME main subject(s) as image 1: same kind of subject (person/people, pet, building, object), the same number of people or animals, and clearly the same scene? A different art style is expected and fine. Answer with exactly one word: YES or NO.',
      image_urls: [photoDataUrl, `data:image/jpeg;base64,${resultBuf.toString('base64')}`],
    }, { timeoutMs: 60000 });
    const txt = String((out && (out.output || out.text)) || '').trim().toUpperCase();
    if (txt.startsWith('NO')) return false;
    return true;
  } catch (e) {
    console.warn('onderwerp-controle overgeslagen:', e.message);
    return true;
  }
}

async function makeVariant({ design, input, target, job, photo, settings }) {
  const check = String((settings && settings.controle_onderwerp) || 'aan') !== 'uit' && photo;
  const tries = check ? Math.max(1, Math.min(4, parseInt(settings.controle_pogingen, 10) || 3)) : 1;
  let buf = null;
  for (let t = 0; t < tries; t++) {
    const inp = t === 0 ? input : { ...input, ...(input.seed !== undefined ? { seed: Math.floor(Math.random() * 2147483647) } : {}) };
    const out = await fal.run(design.model, inp);
    const url = fal.firstImageUrl(out);
    if (!url) throw new Error('Model gaf geen afbeelding terug');
    buf = await download(url);
    if (!check || await subjectMatches(photo, buf, settings)) break;
    console.warn(`onderwerp-controle: resultaat wijkt af van de foto (poging ${t + 1}/${tries}, job ${job.id})`);
    if (t === tries - 1) throw new Error('onderwerp wijkt af van de foto');
  }
  const base = rid();
  const v = { raw_file: `${base}-raw.jpg`, preview_file: `${base}-preview.jpg`, print_file: null };
  fs.writeFileSync(path.join(ORIGINALS, v.raw_file), buf);
  fs.writeFileSync(path.join(FILES, v.preview_file), await img.previewOnly(buf, target));
  await finalizeVariant({ profile: job.profile, orientation: job.orientation }, v); // direct scherp maken, zodat het drukbestand al klaar is bij de keuze
  return v;
}

// Zware deel: indien nodig vergroten en het drukbestand maken. Het ontwerp zelf verandert niet.
async function finalizeVariant(job, v) {
  if (v.print_file && fs.existsSync(path.join(FILES, v.print_file))) return v;
  const settings = allSettings();
  const target = img.targetSize(job.profile, job.orientation, settings);
  let buf = fs.readFileSync(path.join(ORIGINALS, v.raw_file));
  const meta = await require('sharp')(buf).metadata();
  const need = Math.max(target.w / meta.width, target.h / meta.height);
  if (need > 1.05 && settings.upscale_model) {
    const factor = Math.min(4, Math.max(2, Math.ceil(need)));
    const up = await fal.run(settings.upscale_model, { image_url: `data:image/jpeg;base64,${buf.toString('base64')}`, ...(/clarity/i.test(settings.upscale_model) ? { upscale_factor: factor } : {}) });
    const upUrl = fal.firstImageUrl(up);
    if (upUrl) buf = await download(upUrl);
  }
  const { printBuf } = await img.finalize(buf, target);
  v.print_file = `${rid()}-print.jpg`;
  fs.writeFileSync(path.join(FILES, v.print_file), printBuf);
  v.print_w = target.w; v.print_h = target.h;
  return v;
}

// Veiligheidsfilter van fal staat standaard UIT (familiefoto's zoals pasgeborenen werden onterecht geblokkeerd). Instelling 'veiligheidsfilter' = 'aan' zet het weer aan.
// Een ontwerp kan dit zelf overschrijven via de extra parameters (extra_json).
function safetyParams(model, settings) {
  if (String(settings.veiligheidsfilter || 'uit') === 'aan') return {};
  if (/gpt-image|openai/i.test(model)) return {};   // OpenAI-modellen hebben een eigen filter dat hier niet uit kan
  const o = { enable_safety_checker: false };
  if (/flux-pro|kontext/i.test(model)) o.safety_tolerance = '5';
  return o;
}

async function process_(job) {
  const settings = allSettings();
  const design = db.prepare('SELECT * FROM designs WHERE id=?').get(job.design_id);
  if (!design) throw new Error('Ontwerp bestaat niet meer');
  const target = img.targetSize(job.profile, job.orientation, settings);
  const n = Math.min(3, Math.max(1, parseInt(settings.variants, 10) || 1));

  const original = fs.readFileSync(path.join(ORIGINALS, job.original_file));
  let crop = null;
  try { crop = job.crop_json ? JSON.parse(job.crop_json) : null; } catch { /* negeren */ }
  const prepared = await img.prepareInput(original, job.profile, job.orientation, crop, { whole: String(settings.foto_hele_tonen || 'ja') !== 'nee' });

  let extra = {};
  try { extra = JSON.parse(design.extra_json || '{}'); } catch { /* negeren */ }
  const guard = String(settings.prompt_guard || '').trim();
  const prompt = promptFor(design, job.custom_text) + (guard ? ' ' + guard : '');
  const wholeNote = prepared.padded ? ' The customer photo sits on a white canvas with white margins: keep the ENTIRE photo content in frame (nothing cut off or cropped at any edge), keep its proportions, and leave the surrounding space as clean plain background.' : '';
  const base = {
    prompt: prompt + wholeNote,
    image_url: `data:image/jpeg;base64,${prepared.buffer.toString('base64')}`,
    num_images: 1,
    output_format: 'jpeg',
    aspect_ratio: job.profile === 'tegel' ? FAL_RATIO.tegel : FAL_RATIO[job.orientation],
    ...safetyParams(design.model, settings),
    ...extra,
  };
  if (design.negative_prompt) base.negative_prompt = design.negative_prompt;
  // OpenAI/ChatGPT-beeldmodellen op fal verwachten een andere invoer (image_urls, image_size, geen negative prompt/aspect_ratio)
  if (/gpt-image|openai/i.test(design.model)) {
    base.image_urls = [base.image_url];
    if (design.ref_file && fs.existsSync(path.join(ORIGINALS, design.ref_file))) {
      // Referentiebeeld eerst (voorbeeld), daarna de foto van de klant
      const ref = fs.readFileSync(path.join(ORIGINALS, design.ref_file));
      base.image_urls = [`data:image/jpeg;base64,${ref.toString('base64')}`, base.image_url];
      base.prompt = 'Image 1 is a reference example: reproduce its decorative elements (such as the corner ornaments) in the same positions, exactly as shown. Image 2 is the customer photo to transform. ' + base.prompt;
    }
    delete base.image_url; delete base.aspect_ratio; delete base.negative_prompt;
    if (design.negative_prompt) base.prompt += ' Vermijd: ' + design.negative_prompt + '.';
    base.image_size = job.profile === 'tegel' ? '1024x1024' : (job.orientation === 'portrait' ? '1024x1536' : '1536x1024');
    if (!base.quality) base.quality = 'medium';
    delete base.output_format; base.output_format = 'jpeg';
    Object.assign(base, extra);
  }

  // Meerdere varianten tegelijk. Bij flux-modellen geven we elke variant een eigen seed, zodat ze echt verschillen.
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const input = { ...base };
    if (n > 1 && /flux/i.test(design.model) && input.seed === undefined) input.seed = Math.floor(Math.random() * 2147483647);
    jobs.push(makeVariant({ design, input, target, job, photo: `data:image/jpeg;base64,${prepared.buffer.toString('base64')}`, settings }));
  }
  const settled = await Promise.allSettled(jobs);
  const variants = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!variants.length) throw settled[0].reason || new Error('Geen afbeelding gemaakt');

  // Eén variant: meteen definitief. Meer: de klant kiest (chosen/print_file blijven leeg tot die keuze).
  if (variants.length === 1) {
    await finalizeVariant(job, variants[0]);
    db.prepare(`UPDATE jobs SET status='done', variants_json=?, chosen=0, preview_file=?, print_file=?, print_w=?, print_h=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(JSON.stringify(variants), variants[0].preview_file, variants[0].print_file, target.w, target.h, job.id);
  } else {
    db.prepare(`UPDATE jobs SET status='done', variants_json=?, print_w=?, print_h=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(JSON.stringify(variants), target.w, target.h, job.id);
  }
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

module.exports = { finalizeVariant, promptFor, enqueue, resume, rid, FILES, ORIGINALS };
