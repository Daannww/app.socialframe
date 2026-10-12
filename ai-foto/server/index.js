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
const { enqueue, resume, rid, FILES, ORIGINALS } = require('./pipeline');

const app = express();
app.set('trust proxy', 1);
const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const fileUrl = (name) => (name ? `${BASE}/files/${name}` : null);

const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use('/api', cors({ origin: origins.length ? origins : true }));
app.use(express.json({ limit: '1mb' }));

// Publieke bestanden: alleen print/preview/voorbeeld (onraadbare namen), nooit originelen.
app.use('/files', express.static(FILES, { maxAge: '30d', immutable: true }));

// ---------- Publieke API (productpagina) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const publicDesign = (d) => ({ id: d.id, name: d.name, description: d.description, example_url: fileUrl(d.example_file) });

app.get('/api/designs', (req, res) => {
  const product = String(req.query.product || '').trim();
  const rows = db.prepare('SELECT * FROM designs WHERE active=1 ORDER BY sort, id').all()
    .filter((d) => d.products === '*' || !product || d.products.split(',').map((s) => s.trim()).includes(product));
  res.json({ designs: rows.map(publicDesign), max_attempts: parseInt(getSetting('max_attempts'), 10) });
});

const genLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Te veel pogingen, probeer het later opnieuw.' } });

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

    const max = parseInt(getSetting('max_attempts'), 10);
    const used = attemptsUsed(clientId);
    if (used >= max) return res.status(429).json({ error: `Je hebt het maximale aantal pogingen (${max}) gebruikt.`, attempts_left: 0 });

    // Alleen echte afbeeldingen toelaten.
    let meta;
    try { meta = await sharp(req.file.buffer).metadata(); } catch { meta = null; }
    if (!meta || !['jpeg', 'png', 'webp', 'heif'].includes(meta.format)) return res.status(400).json({ error: 'Upload een JPG-, PNG- of HEIC-foto.' });
    if (Math.min(meta.width, meta.height) < 400) return res.status(400).json({ error: 'De foto is te klein, kies een foto van minimaal 800 px.' });

    const id = rid();
    const originalFile = `${id}.jpg`;
    fs.writeFileSync(path.join(ORIGINALS, originalFile), await sharp(req.file.buffer).rotate().jpeg({ quality: 95 }).toBuffer());
    db.prepare('INSERT INTO jobs(id,client_id,ip,design_id,profile,orientation,original_file) VALUES(?,?,?,?,?,?,?)')
      .run(id, clientId, req.ip, design.id, profile, orientation, originalFile);
    enqueue(id);
    res.json({ job_id: id, attempts_left: max - used - 1 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Er ging iets mis, probeer het opnieuw.' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Niet gevonden' });
  const max = parseInt(getSetting('max_attempts'), 10);
  res.json({
    status: j.status,
    error: j.status === 'error' ? 'Het maken van de afbeelding is mislukt. Probeer het opnieuw.' : null,
    preview_url: fileUrl(j.preview_file),
    print_url: fileUrl(j.print_file),
    job_id: j.id,
    attempts_left: Math.max(0, max - attemptsUsed(j.client_id)),
  });
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
      .map((j) => ({ ...j, preview_url: fileUrl(j.preview_file), print_url: fileUrl(j.print_file) })),
  });
});

function designFields(b) {
  let extra = b.extra_json || '{}';
  try { JSON.parse(extra); } catch { throw new Error('Extra parameters zijn geen geldige JSON'); }
  if (!String(b.name || '').trim() || !String(b.prompt || '').trim()) throw new Error('Naam en prompt zijn verplicht');
  return [String(b.name).trim(), b.description || '', b.prompt, b.negative_prompt || '', (b.model || 'fal-ai/flux-pro/kontext').trim(),
    extra, (b.products || '*').trim() || '*', b.active ? 1 : 0, parseInt(b.sort, 10) || 0];
}

app.post('/admin/api/designs', (req, res) => {
  try {
    const f = designFields(req.body);
    const r = db.prepare('INSERT INTO designs(name,description,prompt,negative_prompt,model,extra_json,products,active,sort) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/admin/api/designs/:id', (req, res) => {
  try {
    const f = designFields(req.body);
    db.prepare('UPDATE designs SET name=?,description=?,prompt=?,negative_prompt=?,model=?,extra_json=?,products=?,active=?,sort=? WHERE id=?')
      .run(f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], req.params.id);
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
    for (const [dir, f] of [[ORIGINALS, j.original_file], [FILES, j.preview_file], [FILES, j.print_file]])
      if (f) fs.rmSync(path.join(dir, f), { force: true });
    db.prepare('DELETE FROM jobs WHERE id=?').run(j.id);
  }
}
setInterval(cleanup, 24 * 60 * 60 * 1000).unref();

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => { console.log('AI-foto service op poort', port); resume(); });
}
module.exports = app;
