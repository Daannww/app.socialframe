// Kentekenplaathouder-ontwerper: logo (en voorbeeld) van de klant opslaan voor de orderapp.
// De widget (widget/hw-kenteken.liquid) tekent het ontwerp zelf op een canvas en schrijft cart-eigenschappen
// (Voertuig, Tekst, Lettertype, Opmaak, _Logo ...) die de orderapp (kentekenplaathouder.js) uitleest.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clientIp } = require('./clientip');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

module.exports = function ({ looksLikeBot, base, FILES }) {
  const r = express.Router();
  const lim = (n, ms) => rateLimit({ windowMs: ms, limit: n, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => clientIp(req), validate: false,
    message: { error: 'Te veel pogingen, probeer het later opnieuw.' } });
  const guard = (req, res, next) => (looksLikeBot(req) ? res.status(403).json({ error: 'Dit verzoek is geweigerd.' }) : next());
  const save = (buf, suffix) => { const name = `${crypto.randomBytes(16).toString('hex')}-${suffix}`; fs.writeFileSync(path.join(FILES, name), buf); return `${base}/files/${name}`; };

  // Logo van de klant: PNG/JPG/WebP/SVG/GIF -> PNG met doorzichtige achtergrond (witte achtergrond is in de browser al weggehaald indien gekozen).
  r.post('/api/kenteken/logo', lim(40, 60 * 60 * 1000), guard, upload.single('logo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Geen logo ontvangen.' });
      let meta; try { meta = await sharp(req.file.buffer, { density: 300 }).metadata(); } catch { meta = null; }
      if (!meta || !['jpeg', 'png', 'webp', 'svg', 'gif', 'heif'].includes(meta.format)) return res.status(400).json({ error: 'Upload een PNG-, JPG- of SVG-bestand.' });
      const out = await sharp(req.file.buffer, { density: 300 }).rotate().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: false }).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
      const m = await sharp(out).metadata();
      res.json({ url: save(out, 'kentekenlogo.png'), width: m.width, height: m.height });
    } catch (e) { console.warn('[kenteken] logo', e.message); res.status(500).json({ error: 'Logo opslaan mislukt, probeer het opnieuw.' }); }
  });

  // Voorbeeldafbeelding van het ontwerp (voor in de winkelwagen)
  r.post('/api/kenteken/preview', lim(60, 60 * 60 * 1000), guard, upload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Geen afbeelding ontvangen.' });
      const out = await sharp(req.file.buffer).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      res.json({ url: save(out, 'kentekenpreview.jpg') });
    } catch (e) { res.status(500).json({ error: 'Voorbeeld opslaan mislukt.' }); }
  });

  // Widget als losse HTML (de theme-snippet laadt deze; aanpassingen gaan zo zonder thema-bewerking live) + demo-pagina.
  const widget = () => fs.readFileSync(path.join(__dirname, '..', 'widget', 'hw-kenteken.liquid'), 'utf8')
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '').replace(/\{%-?[\s\S]*?-?%\}/g, '').replace(/data-api="[^"]*"/, `data-api="${base || 'https://ai-foto.socialframe.nl'}"`);
  r.get('/widget/kenteken.html', (req, res) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' }).type('html').send(widget()); });
  r.get('/kenteken-demo', (req, res) => {
    res.set({ 'X-Robots-Tag': 'noindex', 'Access-Control-Allow-Origin': '*' }).type('html').send(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Kenteken demo</title></head><body style="max-width:560px;margin:0 auto;padding:14px;font-family:system-ui,sans-serif">${widget()}</body></html>`);
  });
  return r;
};
