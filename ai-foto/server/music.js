// Muziekframe-generator (Spotify zoeken, Spotify Code, QR-code, foto en voorbeeld uploaden).
// De widget (widget/hw-muziek.liquid) tekent het frame zelf op een canvas en schrijft dezelfde bestelgegevens als Zepto,
// zodat de orderapp (musicframe.js) ongewijzigd het drukbestand kan maken.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-generator');
const { clientIp } = require('./clientip');
const layout = require('./music-layout');

const URI_RE = /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]{10,30}$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const cache = new Map();   // sleutel -> { at, v }
const cget = (k, ttl) => { const e = cache.get(k); if (e && Date.now() - e.at < ttl) return e.v; cache.delete(k); return null; };
const cset = (k, v) => { if (cache.size > 800) cache.delete(cache.keys().next().value); cache.set(k, { at: Date.now(), v }); return v; };

// Spotify-link of -uri -> spotify:type:id (of null)
function toUri(s) {
  const t = String(s || '').trim();
  if (URI_RE.test(t)) return t;
  const m = t.match(/open\.spotify\.com\/(?:[a-z0-9-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/i);
  return m ? `spotify:${m[1].toLowerCase()}:${m[2]}` : null;
}

let token = null;   // { value, exp }
async function spotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token && token.exp > Date.now() + 30000) return token.value;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('spotify token ' + r.status);
  const j = await r.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

const mmss = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const mapTrack = (t) => ({
  id: t.id, uri: t.uri, url: (t.external_urls && t.external_urls.spotify) || `https://open.spotify.com/track/${t.id}`,
  title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '),
  image: ((t.album && t.album.images) || []).slice(-2)[0] ? ((t.album.images.slice(-2)[0]).url) : '',
  duration: mmss(t.duration_ms),
});

module.exports = ({ looksLikeBot, base, FILES }) => {
  const r = express.Router();
  const lim = (n, ms) => rateLimit({ windowMs: ms, limit: n, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => clientIp(req), validate: false, message: { error: 'Te veel verzoeken, probeer het zo opnieuw.' } });
  const guard = (req, res, next) => (looksLikeBot(req) ? res.status(403).json({ error: 'Dit verzoek is geweigerd.' }) : next());

  // Vaste indeling van de plaat (zelfde als het drukbestand) en de marmer-achtergronden
  r.get('/api/music/layout', (req, res) => { res.set('Cache-Control', 'public, max-age=3600'); res.json({ paths: layout, search: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) }); });
  r.get('/api/music/bg/:name', (req, res) => {
    const f = { marmerwit: 'marmerwit.jpg', marmerzwart: 'marmerzwart.jpg' }[req.params.name];
    if (!f) return res.status(404).end();
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=2592000' }).type('jpeg').send(fs.readFileSync(path.join(__dirname, 'assets', 'music', f)));
  });

  // Nummer zoeken
  r.get('/api/music/search', lim(60, 60 * 1000), guard, async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ tracks: [] });
    const key = 's:' + q.toLowerCase();
    const hit = cget(key, 10 * 60 * 1000);
    if (hit) return res.json({ tracks: hit });
    try {
      const tk = await spotifyToken();
      if (!tk) return res.status(503).json({ error: 'Zoeken is nog niet ingesteld. Plak hieronder een Spotify-link.' });
      const sr = await fetch(`https://api.spotify.com/v1/search?type=track&limit=8&market=NL&q=${encodeURIComponent(q)}`, { headers: { Authorization: 'Bearer ' + tk } });
      if (!sr.ok) { console.warn('[music] spotify search', sr.status, (await sr.text().catch(() => '')).slice(0, 300)); return res.status(502).json({ error: 'Zoeken lukt nu niet. Plak hieronder een Spotify-link.' }); }
      const j = await sr.json();
      res.json({ tracks: cset(key, ((j.tracks && j.tracks.items) || []).map(mapTrack)) });
    } catch (e) { console.warn('[music] search', e.message); res.status(502).json({ error: 'Zoeken lukt nu niet. Plak hieronder een Spotify-link.' }); }
  });

  // Eén nummer opzoeken via een Spotify-link (met API, anders via de openbare oEmbed)
  r.get('/api/music/track', lim(60, 60 * 1000), guard, async (req, res) => {
    const uri = toUri(req.query.link);
    if (!uri || !uri.startsWith('spotify:track:')) return res.status(400).json({ error: 'Dit lijkt geen Spotify-nummerlink. Open het nummer in Spotify en kies Delen > Link kopiëren.' });
    const id = uri.split(':')[2];
    const key = 't:' + id;
    const hit = cget(key, 60 * 60 * 1000);
    if (hit) return res.json({ track: hit });
    try {
      const tk = await spotifyToken();
      if (tk) {
        const tr = await fetch(`https://api.spotify.com/v1/tracks/${id}?market=NL`, { headers: { Authorization: 'Bearer ' + tk } });
        if (tr.ok) return res.json({ track: cset(key, mapTrack(await tr.json())) });
        console.warn('[music] spotify track', tr.status, (await tr.text().catch(() => '')).slice(0, 300));
      }
      const o = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(`https://open.spotify.com/track/${id}`));
      if (!o.ok) return res.status(404).json({ error: 'Dit nummer is niet gevonden. Controleer de link.' });
      const j = await o.json();
      res.json({ track: cset(key, { id, uri, url: `https://open.spotify.com/track/${id}`, title: j.title || '', artist: '', image: j.thumbnail_url || '', duration: '' }) });
    } catch (e) { res.status(502).json({ error: 'Het nummer ophalen lukt nu niet.' }); }
  });

  // Spotify Code als SVG: achtergrondkleur (hex) en balkjes (black|white) kiezen, zodat hij op elke plaat past.
  r.get('/api/music/code.svg', lim(120, 60 * 1000), guard, async (req, res) => {
    const uri = toUri(req.query.uri || req.query.link);
    const bg = /^[0-9a-fA-F]{6}$/.test(req.query.bg || '') ? String(req.query.bg).toLowerCase() : 'ffffff';
    const fg = req.query.fg === 'white' ? 'white' : 'black';
    if (!uri) return res.status(400).end();
    const key = `c:${uri}:${bg}:${fg}`;
    let svg = cget(key, 24 * 3600 * 1000);
    if (!svg) {
      const cr = await fetch(`https://scannables.scdn.co/uri/plain/svg/${bg}/${fg}/640/${encodeURIComponent(uri)}`);
      if (!cr.ok) return res.status(404).end();
      svg = cset(key, await cr.text());
    }
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' }).type('image/svg+xml').send(svg);
  });

  // QR-code als SVG (zwart op wit, of eigen kleuren)
  r.get('/api/music/qr.svg', lim(120, 60 * 1000), guard, (req, res) => {
    const text = String(req.query.text || '').trim().slice(0, 500);
    if (!text) return res.status(400).end();
    const hex = (v, d) => (/^[0-9a-fA-F]{6}$/.test(v || '') ? '#' + v : d);
    const dark = hex(req.query.dark, '#000000'), light = hex(req.query.light, '#ffffff');
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), m = 1;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + m},${y + m}h1v1h-1z`;
    const size = n + 2 * m;
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' }).type('image/svg+xml')
      .send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`);
  });

  // Foto van de klant (al uitgesneden door de widget) -> openbare link voor de orderapp
  r.post('/api/music/photo', lim(30, 60 * 60 * 1000), guard, upload.single('photo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Geen foto ontvangen.' });
      let meta; try { meta = await sharp(req.file.buffer).metadata(); } catch { meta = null; }
      if (!meta || !['jpeg', 'png', 'webp', 'heif'].includes(meta.format)) return res.status(400).json({ error: 'Upload een JPG-, PNG- of HEIC-foto.' });
      const out = await sharp(req.file.buffer).rotate().resize({ width: 2800, height: 2800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
      const name = `${crypto.randomBytes(16).toString('hex')}-music.jpg`;
      fs.writeFileSync(path.join(FILES, name), out);
      res.json({ url: `${base}/files/${name}` });
    } catch (e) { console.warn('[music] foto', e.message); res.status(500).json({ error: 'Foto opslaan mislukt, probeer het opnieuw.' }); }
  });

  // Voorbeeldafbeelding van het ontwerp (voor in de winkelwagen)
  r.post('/api/music/preview', lim(30, 60 * 60 * 1000), guard, upload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Geen afbeelding ontvangen.' });
      const out = await sharp(req.file.buffer).resize({ width: 700, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      const name = `${crypto.randomBytes(16).toString('hex')}-musicpreview.jpg`;
      fs.writeFileSync(path.join(FILES, name), out);
      res.json({ url: `${base}/files/${name}` });
    } catch (e) { res.status(500).json({ error: 'Voorbeeld opslaan mislukt.' }); }
  });

  return r;
};
