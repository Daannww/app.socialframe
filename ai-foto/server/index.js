require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { db, getSetting, setSetting, allSettings } = require('./db');
const { finalizeVariant, promptFor, enqueue, resume, rid, FILES, ORIGINALS } = require('./pipeline');

const app = express();
app.set('trust proxy', 1);
const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const fileUrl = (name) => (name ? `${BASE}/files/${name}` : null);

const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
// Toegestane websites: de eigen domeinen uit ALLOWED_ORIGINS, plus Shopify-voorbeeld- en admin-omgevingen (voor testen).
function originAllowed(origin) {
  if (!origin) return true;
  if (!origins.length || origins.includes(origin)) return true;
  try {
    const h = new URL(origin).hostname;
    return h.endsWith('.shopifypreview.com') || h.endsWith('.myshopify.com');
  } catch { return false; }
}
app.use('/api', cors({ origin: (o, cb) => cb(null, originAllowed(o)) }));
app.use(express.json({ limit: '1mb' }));

// Publieke bestanden: alleen print/preview/voorbeeld (onraadbare namen), nooit originelen.
app.use('/files', express.static(FILES, { maxAge: '30d', immutable: true }));

// ---------- Publieke API (productpagina) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const publicDesign = (d) => ({ id: d.id, slug: d.slug, name: d.name, description: d.description, example_url: fileUrl(d.example_file),
  allows_text: !!d.prompt_with_text, text_required: !!(d.prompt_with_text && d.text_required), text_label: d.text_label || 'Tekst op je afbeelding' });

app.get('/api/designs', (req, res) => {
  const product = String(req.query.product || '').trim();
  // Per product ingesteld (metafield "AI stijlen" met slugs) gaat voor; anders de lijst in het ontwerp zelf.
  const styles = String(req.query.styles || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  let rows = db.prepare('SELECT * FROM designs WHERE active=1 ORDER BY sort, id').all();
  if (styles.length) rows = rows.filter((d) => styles.includes((d.slug || '').toLowerCase()));
  else rows = rows.filter((d) => d.products === '*' || !product || d.products.split(',').map((s) => s.trim()).includes(product));
  const maxA = parseInt(getSetting('max_attempts'), 10);
  const cid = String(req.query.client_id || '');
  const left = /^[A-Za-z0-9_-]{8,64}$/.test(cid) ? attemptsLeft(cid, req.ip) : maxA;
  res.json({ designs: rows.map(publicDesign), attempts_left: left, max_attempts: maxA, text_max: parseInt(getSetting('text_max'), 10) });
});

const genLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Te veel pogingen, probeer het later opnieuw.' } });

// Limiet geldt op browsersessie EN op IP-adres: pas als beide gewisseld worden, begint iemand opnieuw.
function attemptsLeft(clientId, ip) {
  const max = parseInt(getSetting('max_attempts'), 10);
  const maxIp = parseInt(getSetting('max_attempts_ip'), 10) || max * 3;
  const byIp = db.prepare("SELECT COUNT(*) c FROM jobs WHERE ip=? AND client_id!='admin-test' AND created_at > datetime('now','-1 day') AND status!='error'").get(ip || '').c;
  return Math.max(0, Math.min(max - attemptsUsed(clientId), maxIp - byIp));
}
function attemptsUsed(clientId) {
  return db.prepare("SELECT COUNT(*) c FROM jobs WHERE client_id=? AND created_at > datetime('now','-1 day') AND status!='error'").get(clientId).c;
}

app.post('/api/generate', genLimiter, upload.single('photo'), async (req, res) => {
  try {
    const clientId = String(req.body.client_id || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
    if (!req.file) return res.status(400).json({ error: 'Geen foto ontvangen.' });
    const profile = req.body.profile === 'poster' ? 'poster' : 'tegel';
    const orientation = req.body.orientation === 'portrait' ? 'portrait' : 'landscape';
    const design = db.prepare('SELECT * FROM designs WHERE id=? AND active=1').get(parseInt(req.body.design_id, 10));
    if (!design) return res.status(400).json({ error: 'Dit ontwerp is niet beschikbaar.' });

    const textMax = parseInt(getSetting('text_max'), 10) || 40;
    const customText = design.prompt_with_text
      ? String(req.body.text || '').replace(/[\u0000-\u001f"<>{}\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, textMax) : '';

    if (design.prompt_with_text && design.text_required && !customText) return res.status(400).json({ error: 'Vul eerst een tekst in voor dit ontwerp.' });

    const max = parseInt(getSetting('max_attempts'), 10);
    if (attemptsLeft(clientId, req.ip) <= 0) return res.status(429).json({ error: `Je hebt het maximale aantal pogingen gebruikt. Probeer het morgen opnieuw.`, attempts_left: 0 });

    // Alleen echte afbeeldingen toelaten.
    let meta;
    try { meta = await sharp(req.file.buffer).metadata(); } catch { meta = null; }
    if (!meta || !['jpeg', 'png', 'webp', 'heif'].includes(meta.format)) return res.status(400).json({ error: 'Upload een JPG-, PNG- of HEIC-foto.' });
    if (Math.min(meta.width, meta.height) < 400) return res.status(400).json({ error: 'De foto is te klein, kies een foto van minimaal 800 px.' });

    const id = rid();
    const originalFile = `${id}.jpg`;
    fs.writeFileSync(path.join(ORIGINALS, originalFile), await sharp(req.file.buffer).rotate().jpeg({ quality: 95 }).toBuffer());
    db.prepare('INSERT INTO jobs(id,client_id,ip,design_id,profile,orientation,original_file,custom_text) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, clientId, req.ip, design.id, profile, orientation, originalFile, customText);
    enqueue(id);
    res.json({ job_id: id, attempts_left: attemptsLeft(clientId, req.ip) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Er ging iets mis, probeer het opnieuw.' });
  }
});

const validClient = (c) => /^[A-Za-z0-9_-]{8,64}$/.test(String(c || ''));
function parseVariants(j) { try { return JSON.parse(j.variants_json || '[]'); } catch { return []; } }

// De klant kiest één van de varianten; pas daarna is er een afbeelding voor de bestelling.
app.post('/api/jobs/:id/choose', async (req, res) => {
  const { client_id: clientId, index } = req.body || {};
  if (!validClient(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
  const j = db.prepare("SELECT j.*, d.name design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id WHERE j.id=? AND j.client_id=? AND j.status='done'").get(req.params.id, clientId);
  if (!j) return res.status(404).json({ error: 'Niet gevonden' });
  const v = parseVariants(j)[parseInt(index, 10)];
  if (!v) return res.status(400).json({ error: 'Deze keuze bestaat niet.' });
  try {
    if (!v.print_file || !fs.existsSync(path.join(FILES, v.print_file))) {
      await finalizeVariant(j, v);
      const all = parseVariants(j); all[parseInt(index, 10)] = v;
      db.prepare('UPDATE jobs SET variants_json=?, print_w=?, print_h=? WHERE id=?').run(JSON.stringify(all), v.print_w || j.print_w, v.print_h || j.print_h, j.id);
    }
  } catch (e) { console.error('[choose]', e.message); return res.status(500).json({ error: 'Scherp maken is mislukt, probeer het opnieuw.' }); }
  db.prepare('UPDATE jobs SET chosen=?, preview_file=?, print_file=? WHERE id=?').run(parseInt(index, 10), v.preview_file, v.print_file, j.id);
  res.json({ job_id: j.id, design: j.design_name, text: j.custom_text || '', preview_url: fileUrl(v.preview_file), print_url: fileUrl(v.print_file), created_at: j.created_at });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Niet gevonden' });
  const max = parseInt(getSetting('max_attempts'), 10);
  res.json({
    status: j.status,
    error: j.status === 'error' ? 'Het maken van de afbeelding is mislukt. Probeer het opnieuw.' : null,
    variants: parseVariants(j).map((v) => ({ preview_url: fileUrl(v.preview_file) })),
    chosen: j.chosen,
    preview_url: fileUrl(j.preview_file),
    print_url: fileUrl(j.print_file),
    job_id: j.id,
    text: j.custom_text || '',
    attempts_left: attemptsLeft(j.client_id, j.ip),
  });
});

// Eerder gemaakte afbeeldingen van deze klant (herbestellen zonder opnieuw te genereren).
const jobCard = (j) => ({ job_id: j.id, design: j.design_name, text: j.custom_text || '', profile: j.profile, orientation: j.orientation,
  preview_url: fileUrl(j.preview_file), created_at: j.created_at });
app.get('/api/history', (req, res) => {
  if (!validClient(req.query.client_id)) return res.json({ items: [] });
  const profile = req.query.profile === 'poster' ? 'poster' : 'tegel';
  const rows = db.prepare(`SELECT j.*, d.name design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id
    WHERE j.client_id=? AND j.status='done' AND j.profile=? AND j.print_file IS NOT NULL ORDER BY j.created_at DESC LIMIT 6`).all(req.query.client_id, profile);
  res.json({ items: rows.filter((j) => fs.existsSync(path.join(FILES, j.print_file))).map(jobCard) });
});
app.post('/api/reuse', (req, res) => {
  const { job_id: jobId, client_id: clientId } = req.body || {};
  if (!validClient(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
  const j = db.prepare("SELECT j.*, d.name design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id WHERE j.id=? AND j.client_id=? AND j.status='done'").get(String(jobId || ''), clientId);
  if (!j || !j.print_file || !fs.existsSync(path.join(FILES, j.print_file))) return res.status(404).json({ error: 'Deze afbeelding is niet meer beschikbaar.' });
  db.prepare("UPDATE jobs SET reuse_count=reuse_count+1, last_reused_at=CURRENT_TIMESTAMP WHERE id=?").run(j.id);
  res.json({ ...jobCard(j), print_url: fileUrl(j.print_file), reuse_count: j.reuse_count + 1 });
});

// ---------- Admin ----------
function adminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(503).send('ADMIN_PASSWORD is niet ingesteld.');
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '');
  const want = Buffer.from(pw);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  res.set('WWW-Authenticate', 'Basic realm="AI-foto admin"').status(401).send('Inloggen vereist');
}
app.use('/admin', adminAuth);
app.use('/admin', express.static(path.join(__dirname, '..', 'public')));

const adminDesign = (d) => ({ ...d, example_url: fileUrl(d.example_file) });

app.get('/admin/api/state', (req, res) => {
  res.json({
    designs: db.prepare('SELECT * FROM designs ORDER BY sort, id').all().map(adminDesign),
    settings: allSettings(),
    has_fal_key: !!process.env.FAL_KEY,
    recent: db.prepare('SELECT j.*, d.name design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id ORDER BY j.created_at DESC LIMIT 30').all()
      .map((j) => { const v0 = parseVariants(j)[0] || {}; return { ...j, preview_url: fileUrl(j.preview_file || v0.preview_file), print_url: fileUrl(j.print_file || v0.print_file), variants: parseVariants(j).length }; }),
  });
});

function designFields(b) {
  let extra = b.extra_json || '{}';
  try { JSON.parse(extra); } catch { throw new Error('Extra parameters zijn geen geldige JSON'); }
  if (!String(b.name || '').trim() || !String(b.prompt || '').trim()) throw new Error('Naam en prompt zijn verplicht');
  if (b.text_required && !String(b.prompt_with_text || '').trim()) throw new Error('Tekst verplicht kan alleen als je ook een "Prompt MET klanttekst" invult');
  const slug = String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Geef een korte code (slug) op, bijvoorbeeld aquarel');
  return [String(b.name).trim(), b.description || '', b.prompt, b.negative_prompt || '', (b.model || 'fal-ai/flux-pro/kontext').trim(),
    extra, (b.products || '*').trim() || '*', b.active ? 1 : 0, parseInt(b.sort, 10) || 0, slug, b.prompt_with_text || '', b.text_label || '', b.text_required ? 1 : 0];
}

app.post('/admin/api/designs', (req, res) => {
  try {
    const f = designFields(req.body);
    const r = db.prepare('INSERT INTO designs(name,description,prompt,negative_prompt,model,extra_json,products,active,sort,slug,prompt_with_text,text_label,text_required) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(...f);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/admin/api/designs/:id', (req, res) => {
  try {
    const f = designFields(req.body);
    db.prepare('UPDATE designs SET name=?,description=?,prompt=?,negative_prompt=?,model=?,extra_json=?,products=?,active=?,sort=?,slug=?,prompt_with_text=?,text_label=?,text_required=? WHERE id=?')
      .run(...f, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/admin/api/designs/:id', (req, res) => {
  db.prepare('DELETE FROM designs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/admin/api/designs/:id/example', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen bestand' });
  const name = `example-${rid()}.jpg`;
  fs.writeFileSync(path.join(FILES, name), await sharp(req.file.buffer).rotate().resize(800, 800, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer());
  db.prepare('UPDATE designs SET example_file=? WHERE id=?').run(name, req.params.id);
  res.json({ example_url: fileUrl(name) });
});
app.put('/admin/api/settings', (req, res) => {
  for (const k of Object.keys(allSettings())) if (req.body[k] !== undefined) setSetting(k, req.body[k]);
  res.json(allSettings());
});
// Testknop: genereert zonder poginglimiet.
app.post('/admin/api/test', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen foto' });
  const id = rid();
  const originalFile = `${id}.jpg`;
  fs.writeFileSync(path.join(ORIGINALS, originalFile), await sharp(req.file.buffer).rotate().jpeg({ quality: 95 }).toBuffer());
  db.prepare('INSERT INTO jobs(id,client_id,ip,design_id,profile,orientation,original_file) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'admin-test', req.ip, parseInt(req.body.design_id, 10), req.body.profile === 'poster' ? 'poster' : 'tegel',
      req.body.orientation === 'portrait' ? 'portrait' : 'landscape', originalFile);
  enqueue(id);
  res.json({ job_id: id });
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect('/admin/'));

// Opruimen van oude (niet-bestelde) bestanden: elke nacht.
function cleanup() {
  const days = parseInt(getSetting('retention_days'), 10) || 180;
  const old = db.prepare("SELECT * FROM jobs WHERE created_at < datetime('now', ?)").all(`-${days} days`);
  for (const j of old) {
    const files = [[ORIGINALS, j.original_file], [FILES, j.preview_file], [FILES, j.print_file]];
    parseVariants(j).forEach((v) => files.push([FILES, v.preview_file], [FILES, v.print_file], [ORIGINALS, v.raw_file]));
    for (const [dir, f] of files) if (f) fs.rmSync(path.join(dir, f), { force: true });
    db.prepare('DELETE FROM jobs WHERE id=?').run(j.id);
  }
}
setInterval(cleanup, 24 * 60 * 60 * 1000).unref();

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => { console.log('AI-foto service op poort', port); resume(); });
}
module.exports = app;
