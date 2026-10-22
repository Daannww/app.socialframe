// Sterrenbeeld-tegeltje: 12 vaste tekeningen (eenmalig door gpt-image gemaakt, door de beheerder goedgekeurd)
// + naam en datum die wij zelf in een vast lettertype eronder zetten (AI maakt te vaak typfouten in namen).
const express = require('express');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const opentype = require('opentype.js');
const fs = require('fs');
const path = require('path');
const { clientIp } = require('./clientip');
const { DATA_DIR, getSetting } = require('./db');
const fal = require('./fal');

const DIR = path.join(DATA_DIR, 'sterrenbeelden');           // goedgekeurde tekeningen: <slug>.png
const CAND = path.join(DIR, 'kandidaten');                     // nieuw gemaakte versies, wachten op goedkeuring: <slug>-<n>.png
const REF = path.join(__dirname, 'assets', 'sterrenbeeld-ref.png');
fs.mkdirSync(CAND, { recursive: true });

// slug, naam, periode, Engelse naam + hoe het sterrenbeeld eruitziet (zodat het model de juiste vorm tekent)
const SIGNS = [
  { slug: 'ram', nl: 'Ram', period: '21 maart – 19 april', en: 'Aries', shape: 'a short curved arc of four stars: a bright star at the right end, then a gentle hook of three fainter stars curving to the left' },
  { slug: 'stier', nl: 'Stier', period: '20 april – 20 mei', en: 'Taurus', shape: 'a V-shaped head with a bright star at the lower end of one arm, and two long horns reaching up and out; a small tight cluster of dots (the Pleiades) at the upper right' },
  { slug: 'tweelingen', nl: 'Tweelingen', period: '21 mei – 20 juni', en: 'Gemini', shape: 'two parallel chains of stars running side by side, each with a bright star at the top (the twins\' heads), connected by short crossbars' },
  { slug: 'kreeft', nl: 'Kreeft', period: '21 juni – 22 juli', en: 'Cancer', shape: 'a faint upside-down Y: a central star with three lines running to three outer stars' },
  { slug: 'leeuw', nl: 'Leeuw', period: '23 juli – 22 augustus', en: 'Leo', shape: 'a sickle (reversed question mark) of six stars forming the lion\'s head and mane, joined to a right triangle of three stars forming the hindquarters and tail' },
  { slug: 'maagd', nl: 'Maagd', period: '23 augustus – 22 september', en: 'Virgo', shape: 'a wide Y-shaped chain of stars with one very bright star (Spica) at the bottom, and arms reaching up to the upper left and upper right' },
  { slug: 'weegschaal', nl: 'Weegschaal', period: '23 september – 22 oktober', en: 'Libra', shape: 'a lopsided diamond / kite of four stars, with a short tail of two stars hanging from the lowest point' },
  { slug: 'schorpioen', nl: 'Schorpioen', period: '23 oktober – 21 november', en: 'Scorpius', shape: 'a long curving tail of stars ending in a hook (the stinger) at the bottom, a bright red heart star (Antares) in the middle, and a short fan of three claw stars at the top' },
  { slug: 'boogschutter', nl: 'Boogschutter', period: '22 november – 21 december', en: 'Sagittarius', shape: 'a teapot: a square body of four stars with a triangular lid on top, a spout on the left and a handle on the right' },
  { slug: 'steenbok', nl: 'Steenbok', period: '22 december – 19 januari', en: 'Capricornus', shape: 'a wide downward-pointing triangle / boat shape of about nine stars, wider at the top and tapering to a tail at the bottom' },
  { slug: 'waterman', nl: 'Waterman', period: '20 januari – 18 februari', en: 'Aquarius', shape: 'a small Y-shaped cluster of four stars (the water jar) with a zig-zag stream of stars flowing down and to the right' },
  { slug: 'vissen', nl: 'Vissen', period: '19 februari – 20 maart', en: 'Pisces', shape: 'two chains of stars forming a wide V, joined at one bright star at the bottom, each ending in a small ring of stars (the two fish)' },
];
const bySlug = Object.fromEntries(SIGNS.map((s) => [s.slug, s]));

// Prompt in de stijl van het voorbeeld: ronde krijt/pen-arcering, zwarte sterretjes met dunne lijnen, verder niets
function promptFor(s) {
  return `Image 1 is the style reference: a hand-drawn circle of soft pencil/ink cross-hatching on pure white, a constellation of black hand-drawn five-pointed stars joined by thin black lines, and a few tiny scattered dots. ` +
    `Draw the constellation ${s.en} (${s.nl}) in exactly the same style, on a clean white square canvas: one round hatched circle, centered, filling about 85% of the width. ` +
    `Constellation shape: ${s.shape}. Use between 5 and 12 stars joined by thin lines, plus a few small loose dots in the circle. ` +
    `Pure white background outside the circle. ABSOLUTELY NO text, letters, numbers, names, dates, borders or signatures anywhere. Keep the same line weight, grain and hatching texture as image 1.`;
}

// ---------- tekeningen beheren ----------
const approvedFile = (slug) => path.join(DIR, `${slug}.png`);
const hasArt = (slug) => !!bySlug[slug];
const candidates = (slug) => fs.readdirSync(CAND).filter((f) => f.startsWith(slug + '-') && f.endsWith('.png')).sort();

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('download ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Maakt één nieuwe kandidaat-tekening (kost één gpt-image-aanroep). De beheerder keurt hem daarna goed.
async function generateCandidate(slug) {
  const s = bySlug[slug];
  if (!s) throw new Error('Onbekend sterrenbeeld');
  const model = getSetting('sterrenbeeld_model') || 'fal-ai/gpt-image-1.5/edit';
  const ref = fs.readFileSync(REF);
  const out = await fal.run(model, {
    prompt: promptFor(s),
    image_urls: [`data:image/png;base64,${ref.toString('base64')}`],
    image_size: '1024x1024', quality: 'high', output_format: 'png', num_images: 1,
  });
  const url = fal.firstImageUrl(out);
  if (!url) throw new Error('Model gaf geen afbeelding terug');
  const buf = await sharp(await download(url)).resize(1024, 1024, { fit: 'cover' }).flatten({ background: '#ffffff' }).png().toBuffer();
  const n = candidates(slug).length + 1;
  const name = `${slug}-${n}.png`;
  fs.writeFileSync(path.join(CAND, name), buf);
  return name;
}

// ---------- naam en datum ----------
let fonts = null;
function loadFonts() {
  if (fonts) return fonts;
  const load = (f) => { const b = fs.readFileSync(path.join(__dirname, 'fonts', f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  fonts = { name: load('CormorantGaramond-Regular.woff'), date: load('CormorantGaramond-Regular.woff') };
  return fonts;
}

// Tekst als SVG-pad (geen systeemlettertypes nodig). Retourneert pad + breedte, gecentreerd op cx.
function textPath(font, text, cx, baseline, size, tracking = 0) {
  const glyphs = font.stringToGlyphs(text);
  const scale = size / font.unitsPerEm;
  let w = 0;
  const adv = glyphs.map((g) => { const a = (g.advanceWidth || 0) * scale; w += a + tracking; return a; });
  w -= tracking;
  let x = cx - w / 2;
  let d = '';
  glyphs.forEach((g, i) => { d += g.getPath(x, baseline, size).toPathData(2); x += adv[i] + tracking; });
  return { d, width: w };
}

const cleanName = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 24);
const NAME_OK = /^[\p{L}\p{M}][\p{L}\p{M} '’.\-&]*$/u;
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{4})$/);
  if (!m) return null;
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${String(d).padStart(2, '0')} · ${String(mo).padStart(2, '0')} · ${y}`;
}


// ---------- echte sterrenbeelden: tekening uit sterrendata (handgetekende stijl) ----------
const CON = JSON.parse(fs.readFileSync(path.join(__dirname, 'sterrenbeelden.json'), 'utf8'));
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function starPath(cx, cy, r, rnd) {
  const pts = []; const rot = rnd() * 1.2 - 0.6 - Math.PI / 2;
  for (let i = 0; i < 10; i++) {
    const rr = (i % 2 ? r * (0.42 + rnd() * 0.08) : r * (0.92 + rnd() * 0.16));
    const a = rot + i * Math.PI / 5 + (rnd() - 0.5) * 0.12;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'Z';
}
function artSvg(slug, N = 1000) {
  const c = CON[slug]; if (!c) throw new Error('Onbekend sterrenbeeld');
  const idx = SIGNS.findIndex((s) => s.slug === slug);
  const rnd = rng(1000 + idx * 77);
  const R = N * 0.47, C = N / 2;
  const d2r = Math.PI / 180, a0 = c.ra0 * d2r, d0 = c.de0 * d2r;
  const proj = (ra, de) => {
    const a = ra * d2r, d = de * d2r;
    const k = 2 / (1 + Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0));
    return [-k * Math.cos(d) * Math.sin(a - a0), k * (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0))];
  };
  const L = c.lines.map((seg) => seg.map((p) => proj(p[0], p[1])));
  const all = L.flat();
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const maxR = Math.max(...all.map((p) => Math.hypot(p[0] - mx, p[1] - my)));
  const scale = Math.min((R * 0.68) / maxR, 62 * 57.3);
  const T = (p) => [C + (p[0] - mx) * scale, C - (p[1] - my) * scale];
  const magAt = {}; c.mags.forEach(([a, b, m]) => { magAt[a.toFixed(3) + ',' + b.toFixed(3)] = m; });
  const nodes = []; // unieke sterren van de lijnfiguur
  const key = (p) => p.k;
  c.lines.forEach((seg) => seg.forEach((p) => { const k = p[0].toFixed(3) + ',' + p[1].toFixed(3); if (!nodes.find((n) => n.k === k)) { const q = T(proj(p[0], p[1])); nodes.push({ k, x: q[0], y: q[1], m: magAt[k] != null ? magAt[k] : 4 }); } }));
  const nodeOf = (p) => nodes.find((n) => n.k === p[0].toFixed(3) + ',' + p[1].toFixed(3));
  const rad = (m) => Math.max(16, Math.min(40, 16 + (4.6 - m) * 9));
  let out = '';
  // arcering: korte, licht gebogen streepjes, dichter naar de rand
  let hatch = '';
  for (let i = 0; i < 9000; i++) {
    const t = Math.pow(rnd(), 0.55); // meer kans richting rand
    const ang = rnd() * Math.PI * 2;
    const rr = R * (0.18 + 0.82 * t);
    const x = C + rr * Math.cos(ang), y = C + rr * Math.sin(ang);
    if (Math.hypot(x - C, y - C) > R) continue;
    const dens = (rr / R);
    if (rnd() > 0.02 + Math.pow(dens, 3.2) * 1.1) continue;
    const len = 18 + rnd() * 46, tilt = -0.22 + (rnd() - 0.5) * 0.18;
    const x2 = x + len * Math.cos(tilt), y2 = y + len * Math.sin(tilt);
    if (Math.hypot(x2 - C, y2 - C) > R * 1.0) continue;
    hatch += `M${x.toFixed(1)} ${y.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  out += `<path d="${hatch}" stroke="#1a1a1a" stroke-opacity=".7" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
  // veldsterren
  const fld = c.field.map((f) => ({ q: T(proj(f[0], f[1])), m: f[2] })).filter((f) => Math.hypot(f.q[0] - C, f.q[1] - C) < R * 0.93 && !nodes.some((n) => Math.hypot(n.x - f.q[0], n.y - f.q[1]) < 46)).sort((a, b) => a.m - b.m).slice(0, 38);
  fld.forEach((f) => { const r = Math.max(2.4, 5.2 - (f.m - 2) * 0.9); out += `<circle cx="${f.q[0].toFixed(1)}" cy="${f.q[1].toFixed(1)}" r="${r.toFixed(1)}" fill="#1a1a1a"/>`; });
  // lijnen
  let ln = '';
  c.lines.forEach((seg) => { for (let i = 0; i < seg.length - 1; i++) {
    const a = nodeOf(seg[i]), b = nodeOf(seg[i + 1]); const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy); if (d < 1) continue;
    const ga = rad(a.m) + 3, gb = rad(b.m) + 3; if (d <= ga + gb) continue;
    ln += `M${(a.x + dx / d * ga).toFixed(1)} ${(a.y + dy / d * ga).toFixed(1)}L${(b.x - dx / d * gb).toFixed(1)} ${(b.y - dy / d * gb).toFixed(1)}`; } });
  out += `<path d="${ln}" stroke="#1a1a1a" stroke-width="3.2" stroke-linecap="round" fill="none"/>`;
  nodes.forEach((n) => { out += `<path d="${starPath(n.x, n.y, rad(n.m), rnd)}" fill="#111" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/>`; });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}"><rect width="${N}" height="${N}" fill="#fff"/>${out}</svg>`;
}
const artBuffer = (slug, N = 1000) => sharp(Buffer.from(artSvg(slug, N))).png().toBuffer();

// Tekent het hele ontwerp: tekening bovenin, naam en datum eronder. size = zijde in pixels (vierkant).
async function render({ slug, name, date, size = 1500, art = null, format = 'jpeg' }) {
  const s = bySlug[slug];
  if (!s) throw new Error('Onbekend sterrenbeeld');
  const artBuf = art || await artBuffer(slug, 1600);
  if (!artBuf) throw new Error('Van dit sterrenbeeld is nog geen goedgekeurde tekening');
  const nm = cleanName(name);
  if (nm && !NAME_OK.test(nm)) throw new Error('Gebruik alleen letters in de naam');
  const dt = date ? parseDate(date) : '';
  if (date && !dt) throw new Error('Gebruik de datum als dd-mm-jjjj');

  const f = loadFonts();
  const k = size / 1500;
  const artSize = Math.round(1000 * k);
  const artTop = Math.round(95 * k);
  const maxW = 1000 * k;
  let nameSize = 170 * k;
  let np = nm ? textPath(f.name, nm, size / 2, 0, nameSize, 4 * k) : null;
  if (np && np.width > maxW) { nameSize *= maxW / np.width; }
  const nameBase = Math.round(1255 * k);
  if (nm) np = textPath(f.name, nm, size / 2, nameBase, nameSize, 4 * k);
  const dateSize = 62 * k;
  const dp = dt ? textPath(f.date, dt, size / 2, Math.round((nm ? 1390 : 1300) * k), dateSize, 7 * k) : null;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g fill="#1a1a1a">${np ? `<path d="${np.d}"/>` : ''}${dp ? `<path d="${dp.d}"/>` : ''}</g></svg>`;
  const artLayer = await sharp(artBuf).resize(artSize, artSize, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).toBuffer();
  let p = sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } })
    .composite([{ input: artLayer, left: Math.round((size - artSize) / 2), top: artTop, blend: 'multiply' }, { input: Buffer.from(svg), top: 0, left: 0 }]);
  return format === 'png' ? p.png().toBuffer() : p.jpeg({ quality: 92 }).toBuffer();
}

// ---------- routes ----------
module.exports = ({ looksLikeBot }) => {
  const r = express.Router();
  const lim = (n, ms) => rateLimit({ windowMs: ms, limit: n, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => clientIp(req), validate: false, message: { error: 'Te veel verzoeken, probeer het zo opnieuw.' } });
  const guard = (req, res, next) => (looksLikeBot(req) ? res.status(403).json({ error: 'Dit verzoek is geweigerd.' }) : next());

  // Klant: welke sterrenbeelden zijn beschikbaar (alleen met goedgekeurde tekening)
  r.get('/api/sterrenbeeld/signs', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ signs: SIGNS.filter((s) => hasArt(s.slug)).map(({ slug, nl, period }) => ({ slug, nl, period })) });
  });

  // Klant: voorbeeld (jpeg) met naam en datum
  r.get('/api/sterrenbeeld/preview', guard, lim(60, 60 * 1000), async (req, res) => {
    try {
      const buf = await render({ slug: String(req.query.sign || ''), name: req.query.name, date: req.query.date, size: 900 });
      res.set({ 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' }).type('jpeg').send(buf);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Tekening zelf (zonder tekst), voor de tegel-mockup
  r.get('/api/sterrenbeeld/art/:slug', (req, res) => {
    if (!bySlug[req.params.slug] || !hasArt(req.params.slug)) return res.status(404).end();
    artBuffer(req.params.slug, 1200).then((b) => res.set({ 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' }).type('png').send(b)).catch(() => res.status(500).end());
  });

  // Drukbestand (voor de orderapp en de beheerder), achter /admin dus met inlog
  r.get('/admin/api/sterrenbeeld/print', async (req, res) => {
    try {
      const px = Math.min(4000, Math.max(600, parseInt(req.query.px, 10) || 1500));
      const buf = await render({ slug: String(req.query.sign || ''), name: req.query.name, date: req.query.date, size: px, format: 'png' });
      res.type('png').send(buf);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Beheer: overzicht, nieuwe kandidaat maken, goedkeuren
  r.get('/admin/api/sterrenbeeld', (req, res) => {
    res.json({ signs: SIGNS.map((s) => ({ slug: s.slug, nl: s.nl, period: s.period, approved: hasArt(s.slug), candidates: candidates(s.slug) })) });
  });
  r.get('/admin/api/sterrenbeeld/kandidaat/:file', (req, res) => {
    const f = path.basename(req.params.file);
    const p = path.join(CAND, f);
    if (!/^[a-z]+-\d+\.png$/.test(f) || !fs.existsSync(p)) return res.status(404).end();
    res.sendFile(p);
  });
  r.post('/admin/api/sterrenbeeld/:slug/genereer', async (req, res) => {
    try { res.json({ file: await generateCandidate(req.params.slug) }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.post('/admin/api/sterrenbeeld/:slug/goedkeuren', express.json(), (req, res) => {
    const f = path.basename(String((req.body && req.body.file) || ''));
    const p = path.join(CAND, f);
    if (!bySlug[req.params.slug] || !f.startsWith(req.params.slug + '-') || !fs.existsSync(p)) return res.status(400).json({ error: 'Onbekende tekening' });
    fs.copyFileSync(p, approvedFile(req.params.slug));
    res.json({ ok: true });
  });
  // Eenvoudige beheerpagina: alle 12 maken, bekijken en goedkeuren
  r.get('/admin/sterrenbeeld', (req, res) => {
    res.type('html').send(PAGE);
  });
  return r;
};
module.exports.render = render;
module.exports.SIGNS = SIGNS;
module.exports.parseDate = parseDate;

const PAGE = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sterrenbeelden</title>
<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:20px auto;padding:0 14px;color:#222}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}.c{border:1px solid #ddd;border-radius:10px;padding:10px}.c h3{margin:0 0 4px}.c small{color:#777}.th{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.th img{width:100px;height:100px;object-fit:cover;border:2px solid #eee;border-radius:6px;cursor:pointer}.th img.ok{border-color:#2a9d4a}button{padding:8px 12px;cursor:pointer}.pv{width:100%;border-radius:6px;background:#fff}</style></head><body>
<h1>Sterrenbeelden</h1><p>Maak per sterrenbeeld een tekening, klik er een aan om hem goed te keuren (groene rand = in gebruik). Elke keer \\u201cNieuwe tekening\\u201d kost één gpt-image-aanroep.</p>
<div style="margin:10px 0"><input id="nm" value="Tijay" style="padding:8px"> <input id="dt" value="28-09-2026" style="padding:8px;width:110px"> <small>naam en datum voor het voorbeeld</small></div>
<div class="g" id="g"></div>
<script>
const g=document.getElementById('g');
async function load(){const j=await (await fetch('/admin/api/sterrenbeeld')).json();g.innerHTML='';j.signs.forEach(s=>{
 const c=document.createElement('div');c.className='c';
 c.innerHTML='<h3>'+s.nl+'</h3><small>'+s.period+'</small><div class="th"></div><button class="gen">Nieuwe tekening</button> <span class="st"></span>'+(s.approved?'<img class="pv" src="/api/sterrenbeeld/preview?sign='+s.slug+'&name='+encodeURIComponent(nm.value)+'&date='+encodeURIComponent(dt.value)+'&t='+Date.now()+'">':'');
 const th=c.querySelector('.th');
 s.candidates.forEach(f=>{const i=new Image();i.src='/admin/api/sterrenbeeld/kandidaat/'+f;i.title='Klik om goed te keuren';i.onclick=async()=>{await fetch('/admin/api/sterrenbeeld/'+s.slug+'/goedkeuren',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:f})});load();};th.appendChild(i);});
 c.querySelector('.gen').onclick=async e=>{const st=c.querySelector('.st');e.target.disabled=true;st.textContent='bezig… (±1 min)';const r=await fetch('/admin/api/sterrenbeeld/'+s.slug+'/genereer',{method:'POST'});const x=await r.json();if(x.error)st.textContent=x.error;else load();e.target.disabled=false;};
 g.appendChild(c);});}
load();
</script></body></html>`;
