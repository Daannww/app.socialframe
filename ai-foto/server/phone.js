// Foto's vanaf de telefoon: de computer maakt een korte sessiecode + QR-code, de telefoon opent de link en stuurt een foto,
// de computer haalt die op. Alles blijft maar kort in het geheugen (geen opslag op schijf, geen database).
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const { clientIp } = require('./clientip');

const TTL_MS = 30 * 60 * 1000;      // een sessie leeft 30 minuten
const MAX_SESSIONS = 300;
const sessions = new Map();         // code -> { created, seq, photo: Buffer|null, at }
const CODE_RE = /^[a-z0-9]{12}$/;

function sweep() { const now = Date.now(); for (const [k, s] of sessions) if (now - s.created > TTL_MS) sessions.delete(k); }
setInterval(sweep, 60 * 1000).unref();

const page = (title, body) => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>*{box-sizing:border-box}body{font-family:Montserrat,system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:28px 20px;color:#222;background:#fff;max-width:480px;margin:0 auto}
h1{font-size:22px;margin:0 0 8px}p{color:#555;line-height:1.5;margin:0 0 18px}
.pick{display:block;border:1.5px dashed #bbb;border-radius:16px;padding:22px 14px;text-align:center;font-weight:600;cursor:pointer;margin-bottom:14px}
.pick small{display:block;font-weight:400;color:#777;margin-top:4px}
img{max-width:100%;border-radius:12px;display:block;margin:0 auto 14px}
button{width:100%;border:1.5px solid #111;border-radius:999px;background:#111;color:#fff;padding:14px;font:inherit;font-size:16px;font-weight:600}
button:disabled{opacity:.4}.msg{margin-top:14px;font-size:15px}.err{color:#b3261e}.ok{color:#1b6e2f;font-weight:600}</style></head><body>${body}</body></html>`;

const mobilePage = (code) => page('Foto versturen', `<h1>Foto versturen</h1><p>Kies een foto van je telefoon of tablet. Hij verschijnt direct op je computer.</p>
<label class="pick" for="f">Foto kiezen of maken<small>Uit je galerij of met de camera</small></label>
<input type="file" id="f" accept="image/*" hidden>
<button id="go" disabled>Verstuur naar mijn computer</button><div class="msg" id="msg" role="status"></div><img id="pv" alt="" hidden style="margin-top:14px">
<script>(function(){var f=document.getElementById('f'),go=document.getElementById('go'),pv=document.getElementById('pv'),msg=document.getElementById('msg');
function say(t,c){msg.textContent=t||'';msg.className='msg '+(c||'');}
f.addEventListener('change',function(){var x=f.files[0];say('');go.disabled=!x;if(x){try{pv.src=URL.createObjectURL(x);pv.hidden=false;}catch(e){}}});
go.addEventListener('click',function(){var x=f.files[0];if(!x)return;go.disabled=true;say('Bezig met versturen…');
var fd=new FormData();fd.append('photo',x);
fetch('/api/phone/${code}/upload',{method:'POST',body:fd}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
.then(function(r){if(!r.ok)throw new Error(r.j.error||'Versturen mislukt');say('Gelukt! Je foto staat nu op je computer. Je kunt dit venster sluiten, of nog een andere foto kiezen.','ok');go.disabled=false;})
.catch(function(e){say(e.message||'Versturen mislukt, probeer het opnieuw.','err');go.disabled=false;});});})();</script>`);

const qrcode = require('qrcode-generator');

module.exports = function phoneRoutes({ looksLikeBot, base }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
  const mk = (limit) => rateLimit({ windowMs: 60 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => clientIp(req), validate: false,
    message: { error: 'Te veel verzoeken, probeer het later opnieuw.' } });
  const bot = (req, res, next) => (looksLikeBot(req) ? res.status(403).json({ error: 'Dit verzoek is geweigerd.' }) : next());

  r.post('/api/phone/session', mk(30), bot, (req, res) => {
    sweep();
    if (sessions.size >= MAX_SESSIONS) return res.status(503).json({ error: 'Even druk, probeer het zo opnieuw.' });
    const code = crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12);
    sessions.set(code, { created: Date.now(), seq: 0, photo: null });
    res.json({ code, ttl_seconds: TTL_MS / 1000 });
  });

  // De computer vraagt om de paar seconden of er een foto is.
  r.get('/api/phone/:code', (req, res) => {
    const s = CODE_RE.test(req.params.code) && sessions.get(req.params.code);
    if (!s || Date.now() - s.created > TTL_MS) return res.status(404).json({ error: 'Deze koppeling is verlopen.' });
    res.json({ seq: s.seq });
  });
  r.get('/api/phone/:code/qr.svg', (req, res) => {
    const s = CODE_RE.test(req.params.code) && sessions.get(req.params.code);
    if (!s) return res.status(404).end();
    const origin = base || (req.protocol + '://' + req.get('host'));
    const q = qrcode(0, 'M'); q.addData(origin + '/m/' + req.params.code); q.make();
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'image/svg+xml' }).send(q.createSvgTag({ cellSize: 4, margin: 12, scalable: true }));
  });
  r.get('/api/phone/:code/photo', (req, res) => {
    const s = CODE_RE.test(req.params.code) && sessions.get(req.params.code);
    if (!s || !s.photo) return res.status(404).json({ error: 'Geen foto.' });
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'image/jpeg' }).send(s.photo);
  });

  r.post('/api/phone/:code/upload', mk(60), bot, upload.single('photo'), async (req, res) => {
    try {
      const s = CODE_RE.test(req.params.code) && sessions.get(req.params.code);
      if (!s || Date.now() - s.created > TTL_MS) return res.status(404).json({ error: 'Deze koppeling is verlopen. Scan de QR-code opnieuw.' });
      if (!req.file) return res.status(400).json({ error: 'Geen foto ontvangen.' });
      let meta; try { meta = await sharp(req.file.buffer).metadata(); } catch { meta = null; }
      if (!meta || !['jpeg', 'png', 'webp', 'heif'].includes(meta.format)) return res.status(400).json({ error: 'Kies een JPG-, PNG- of HEIC-foto.' });
      // Altijd naar JPEG (HEIC kan de computer niet tonen), gedraaid zoals gefotografeerd, max 4000 px.
      s.photo = await sharp(req.file.buffer).rotate().resize({ width: 4000, height: 4000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
      s.seq += 1;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Er ging iets mis, probeer het opnieuw.' }); }
  });

  // De pagina die de telefoon opent na het scannen.
  r.get('/m/:code', (req, res) => {
    const code = req.params.code;
    res.set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' });
    const s = CODE_RE.test(code) && sessions.get(code);
    if (!s || Date.now() - s.created > TTL_MS) return res.status(404).type('html').send(page('Verlopen', '<h1>Link verlopen</h1><p>Deze koppeling werkt niet meer. Scan de QR-code op je computer opnieuw.</p>'));
    res.type('html').send(mobilePage(code));
  });
  return r;
};
