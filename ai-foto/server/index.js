require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { clientIp } = require('./clientip');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const img = require('./image');
const { db, getSetting, setSetting, allSettings } = require('./db');
const routesLib = require('./routes');
const { seedRoutes } = require('./seedRoutes');
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
app.use('/fonts', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); }, express.static(path.join(__dirname, '..', 'fonts'), { maxAge: '30d' }));
app.use('/widget-img', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); }, express.static(path.join(__dirname, '..', 'widget', 'img'), { maxAge: '1d' }));
app.use('/files', express.static(FILES, { maxAge: '30d', immutable: true }));

// ---------- Publieke API (productpagina) ----------
// De orderapp meldt hier welk bestelnummer bij welke foto hoort (geheim via ORDER_LINK_SECRET). Body: { orders: [{ job_id, order_name, print }] }
app.post('/api/order-link', (req, res) => {
  const secret = process.env.ORDER_LINK_SECRET;
  if (!secret || req.get('x-link-secret') !== secret) return res.status(401).json({ error: 'niet toegestaan' });
  let n = 0;
  for (const o of (Array.isArray(req.body && req.body.orders) ? req.body.orders : []).slice(0, 200)) {
    const name = String(o.order_name || '').slice(0, 40), id = String(o.job_id || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
    if (!name || !id) continue;
    const cur = db.prepare('SELECT order_name FROM jobs WHERE id=?').get(id);
    if (!cur) continue;
    const list = String(cur.order_name || '').split(', ').filter(Boolean);
    if (!list.includes(name)) { list.push(name); db.prepare('UPDATE jobs SET order_name=? WHERE id=?').run(list.join(', '), id); n++; }
  }
  res.json({ linked: n });
});

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
  const left = /^[A-Za-z0-9_-]{8,64}$/.test(cid) ? attemptsLeft(cid, clientIp(req)) : maxA;
  res.json({ designs: rows.map(publicDesign), attempts_left: left, max_attempts: maxA, text_max: parseInt(getSetting('text_max'), 10) });
});

const genLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => clientIp(req), skip: (req) => unlimitedIp(clientIp(req)), validate: false,
  message: { error: 'Te veel pogingen, probeer het later opnieuw.' } });

// Limiet geldt op browsersessie EN op IP-adres: pas als beide gewisseld worden, begint iemand opnieuw.
const unlimitedIp = (ip) => String(getSetting('onbeperkt_ips') || '').split(/[\s,;]+/).filter(Boolean).some((x) => x === ip || (x.endsWith('.') && String(ip || '').startsWith(x)));   // 'a.b.c.d' of voorvoegsel 'a.b.'
function attemptsLeft(clientId, ip) {
  const max = parseInt(getSetting('max_attempts'), 10);
  if (unlimitedIp(ip)) return max;   // eigen IP-adressen: nooit beperkt
  const maxIp = parseInt(getSetting('max_attempts_ip'), 10) || max * 3;
  const byIp = db.prepare("SELECT COUNT(*) c FROM jobs WHERE ip=? AND client_id!='admin-test' AND profile!='kaart' AND created_at > datetime('now','-1 day') AND status!='error'").get(ip || '').c;
  return Math.max(0, Math.min(max - attemptsUsed(clientId), maxIp - byIp));
}
function attemptsUsed(clientId) {
  return db.prepare("SELECT COUNT(*) c FROM jobs WHERE client_id=? AND profile!='kaart' AND created_at > datetime('now','-1 day') AND status!='error'").get(clientId).c;
}

app.post('/api/generate', genLimiter, (req, res, next) => (looksLikeBot(req) ? res.status(403).json({ error: 'Dit verzoek is geweigerd.' }) : next()), upload.single('photo'), async (req, res) => {
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
    if (attemptsLeft(clientId, clientIp(req)) <= 0) return res.status(429).json({ error: `Je credits zijn op. Probeer het morgen weer.`, attempts_left: 0 });

    // Alleen echte afbeeldingen toelaten.
    let meta;
    try { meta = await sharp(req.file.buffer).metadata(); } catch { meta = null; }
    if (!meta || !['jpeg', 'png', 'webp', 'heif'].includes(meta.format)) return res.status(400).json({ error: 'Upload een JPG-, PNG- of HEIC-foto.' });
    if (Math.min(meta.width, meta.height) < 400) return res.status(400).json({ error: 'De foto is te klein, kies een foto van minimaal 800 px.' });

    const id = rid();
    const originalFile = `${id}.jpg`;
    fs.writeFileSync(path.join(ORIGINALS, originalFile), await sharp(req.file.buffer).rotate().jpeg({ quality: 95 }).toBuffer());
    // Optionele uitsnede (fracties van de foto): alleen geldig als het een echt vak binnen de foto is.
    let cropJson = null;
    const cr = ['crop_x', 'crop_y', 'crop_w', 'crop_h'].map((k) => parseFloat(req.body[k]));
    if (cr.every((n) => Number.isFinite(n))) {
      const [x, y, w, h] = cr.map((n) => Math.min(1, Math.max(0, n)));
      if (w >= 0.05 && h >= 0.05 && x + w <= 1.001 && y + h <= 1.001) cropJson = JSON.stringify({ x, y, w, h });
    }
    db.prepare('INSERT INTO jobs(id,client_id,ip,design_id,profile,orientation,original_file,custom_text,crop_json,ua,country) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, clientId, clientIp(req), design.id, profile, orientation, originalFile, customText, cropJson, String(req.headers['user-agent'] || '').slice(0, 200), String(req.headers['cf-ipcountry'] || '').slice(0, 4));
    enqueue(id);
    res.json({ job_id: id, attempts_left: attemptsLeft(clientId, clientIp(req)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Er ging iets mis, probeer het opnieuw.' });
  }
});

// Landkaart-tegeltje: de browser van de klant maakt het beeld (kaart + tekst + pin); wij maken er het drukbestand van.
const mapLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => clientIp(req), skip: (req) => unlimitedIp(clientIp(req)), validate: false,
  message: { error: 'Te veel pogingen, probeer het later opnieuw.' } });
app.get('/api/map/config', (req, res) => res.set('Cache-Control', 'public, max-age=60').json({ print_px: Math.min(3200, Math.max(1200, parseInt(getSetting('tegel_px'), 10) || 2000)) }));
app.post('/api/map/print', mapLimiter, (req, res, next) => (looksLikeBot(req) ? res.status(403).json({ error: 'Dit verzoek is geweigerd.' }) : next()), upload.single('image'), async (req, res) => {
  try {
    const clientId = String(req.body.client_id || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
    if (!req.file) return res.status(400).json({ error: 'Geen afbeelding ontvangen.' });
    let meta; try { meta = await sharp(req.file.buffer).metadata(); } catch { meta = null; }
    if (!meta || !['jpeg', 'png', 'webp'].includes(meta.format) || Math.min(meta.width, meta.height) < 600) return res.status(400).json({ error: 'Ongeldige afbeelding.' });
    const clean = (v) => String(v || '').replace(/[\u0000-\u001f"<>{}\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const place = clean(req.body.place), country = clean(req.body.country), style = clean(req.body.style);
    const target = img.targetSize('tegel', 'landscape', allSettings());
    const { printBuf, previewBuf } = await img.finalize(await sharp(req.file.buffer).flatten({ background: '#ffffff' }).toBuffer(), target);
    const id = rid();
    const printFile = `${rid()}-print.jpg`, previewFile = `${rid()}-preview.jpg`;
    fs.writeFileSync(path.join(FILES, printFile), printBuf);
    fs.writeFileSync(path.join(FILES, previewFile), previewBuf);
    db.prepare("INSERT INTO jobs(id,client_id,ip,design_id,profile,orientation,status,preview_file,print_file,print_w,print_h,chosen,custom_text,ua,country,finished_at) VALUES(?,?,?,0,'kaart','landscape','done',?,?,?,?,0,?,?,?,CURRENT_TIMESTAMP)")
      .run(id, clientId, clientIp(req), previewFile, printFile, target.w, target.h, [place, country].filter(Boolean).join(', ') + (style ? ' · ' + style : ''),
        String(req.headers['user-agent'] || '').slice(0, 200), String(req.headers['cf-ipcountry'] || '').slice(0, 4));
    res.json({ job_id: id, preview_url: fileUrl(previewFile), print_url: fileUrl(printFile) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Er ging iets mis, probeer het opnieuw.' });
  }
});

// Foto's vanaf de telefoon (QR-code)
app.use(require('./phone')({ looksLikeBot, base: BASE }));
app.use(require('./music')({ looksLikeBot, base: BASE, FILES }));

// ---------- Routes (sporttegeltje) ----------
app.get('/api/routes', (req, res) => {
  res.json({ routes: db.prepare('SELECT id, name, sport, place, country, distance_km FROM routes WHERE active=1 ORDER BY sort, name').all()
    .map((r) => ({ id: r.id, name: r.name, sport: r.sport || '', place: r.place || '', country: r.country || '', distance_km: Math.round((r.distance_km || 0) * 10) / 10 })) });
});
app.get('/api/routes/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM routes WHERE id=? AND active=1').get(String(req.params.id || ''));
  if (!r) return res.status(404).json({ error: 'Route niet gevonden.' });
  res.set('Cache-Control', 'public, max-age=300').json({ id: r.id, name: r.name, sport: r.sport || '', place: r.place || '', country: r.country || '', distance_km: Math.round((r.distance_km || 0) * 10) / 10, points: JSON.parse(r.points_json) });
});

// Muziekframe-widget als losse HTML (de theme-snippet laadt deze; aanpassingen gaan zo zonder thema-bewerking live).
app.get('/widget/muziek.html', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'widget', 'hw-muziek.liquid'), 'utf8')
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '').replace(/\{%-?[\s\S]*?-?%\}/g, '').replace(/data-api="[^"]*"/, `data-api="${BASE || 'https://ai-foto.socialframe.nl'}"`);
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' }).type('html').send(html);
});

// Demo-pagina voor de routewidget (zonder winkelwagen).
app.get('/route-demo', (req, res) => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'widget', 'hw-route.liquid'), 'utf8')
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '').replace(/\{%-?[\s\S]*?-?%\}/g, '').replace('data-hw-route ', 'data-hw-route data-demo="1" ').replace(/data-api="[^"]*"/, `data-api="${BASE}"`);
  res.set({ 'X-Robots-Tag': 'noindex', 'Access-Control-Allow-Origin': '*' }).type('html').send(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Route-demo</title><style>body{font-family:Montserrat,system-ui,sans-serif;max-width:520px;margin:20px auto;padding:0 12px}</style></head><body>${widget}</body></html>`);
});

// Demo-pagina om de kaartwidget te testen (zonder winkelwagen). Niet door zoekmachines te indexeren.
app.get('/kaart-demo', (req, res) => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'widget', 'hw-kaart.liquid'), 'utf8')
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '').replace(/\{%-?[\s\S]*?-?%\}/g, '').replace('data-hw-kaart ', 'data-hw-kaart data-demo="1" ').replace(/data-api="[^"]*"/, `data-api="${BASE}"`)
    .replace(/data-google-key="[^"]*"/, 'data-google-key=""');
  // Extra knoppen (alleen op deze demo-pagina): zet de kaart zelf goed en download dan het drukbestand en/of de tegel-mockup (webp).
  const gal = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><button type="button" id="dl-print" style="padding:12px 16px;font:600 14px inherit;font-family:inherit;cursor:pointer">Download drukbestand (jpg)</button><button type="button" id="dl-mock" style="padding:12px 16px;font:600 14px inherit;font-family:inherit;cursor:pointer">Download mockup (webp)</button></div><div id="dl-st" style="font-size:13px;margin-bottom:8px"></div>`;
  const dlScript = `<script>(function(){
var st=document.getElementById('dl-st');
function slug(s){return (s||'tegel').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'tegel';}
function save(blob,name){var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();}
function go(kind){var k=window.__hwKaart; if(!k||!k.getMap()){st.textContent='De kaart is nog niet geladen.';return;}
  var city=(document.querySelector('[data-hw-k-city]')||{}).value, base=${JSON.stringify(BASE)}; st.textContent='Bezig met maken…';
  k.buildAndUpload().then(function(r){ var u=kind==='print'?r.print_url:base+'/api/map/mockup/'+r.job_id+'.webp';
    return fetch(u).then(function(x){if(!x.ok)throw new Error('download mislukt');return x.blob();}).then(function(b){save(b,'landkaart-tegeltje-'+slug(city)+(kind==='print'?'-drukbestand.jpg':'-mockup.webp'));st.textContent='Klaar.';});
  }).catch(function(e){st.textContent='Fout: '+(e&&e.message||e);});}
document.getElementById('dl-print').onclick=function(){go('print');};
document.getElementById('dl-mock').onclick=function(){go('mock');};
})();</script>`;
  res.set({ 'X-Robots-Tag': 'noindex', 'Access-Control-Allow-Origin': '*' }).type('html').send(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Kaart-demo</title><style>body{font-family:Montserrat,system-ui,sans-serif;max-width:520px;margin:20px auto;padding:0 12px}</style></head><body>${widget}${gal}${dlScript}</body></html>`);
});

// Tegel-mockup: het drukbestand van een kaart-job achter de tegel-foto, als webp.
app.get('/api/map/mockup/:id.webp', async (req, res) => {
  try {
    const j = db.prepare("SELECT print_file FROM jobs WHERE id=? AND profile='kaart'").get(String(req.params.id || ''));
    const f = j && j.print_file && path.join(FILES, path.basename(j.print_file));
    if (!f || !fs.existsSync(f)) return res.status(404).json({ error: 'Niet gevonden.' });
    const buf = await require('./mockup').tegelMockup(f);
    res.set({ 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' }).type('image/webp').send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Mockup maken mislukt.' }); }
});

// Batchpagina: maakt per stad het drukbestand (zoals de kaartwidget) en zet het in de tegel-mockup. Niet te indexeren.
// [stad, lengte, breedte, km die het kaartbeeld breed moet zijn]: grote steden ruim (heel centrum), kleinere steden (bijna) de hele stad
const MOCK_CITIES = [['Amsterdam', 4.9, 52.365, 7.5], ['Rotterdam', 4.4777, 51.9244, 8], ['Den Haag', 4.3007, 52.0705, 8], ['Utrecht', 5.1214, 52.0907, 6], ['Eindhoven', 5.4697, 51.4416, 6],
  ['Groningen', 6.5665, 53.2194, 5.5], ['Tilburg', 5.0913, 51.5555, 5.5], ['Almere', 5.2647, 52.3508, 7], ['Breda', 4.776, 51.589, 5], ['Nijmegen', 5.8528, 51.8126, 6], ['Arnhem', 5.8987, 51.9851, 6],
  ['Haarlem', 4.6462, 52.3874, 4.5], ['Enschede', 6.8937, 52.2215, 5], ['Apeldoorn', 5.9699, 52.2112, 6], ['Amersfoort', 5.3878, 52.1561, 4.5], ['Zwolle', 6.083, 52.5168, 4.5], ['Leiden', 4.497, 52.1601, 4.5],
  ['Maastricht', 5.6909, 50.8514, 5], ['Dordrecht', 4.69, 51.8133, 4.5], ['Delft', 4.3571, 52.0116, 4], ['Den Bosch', 5.3047, 51.6978, 4.5]];
app.get('/kaart-mockups', (req, res) => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'widget', 'hw-kaart.liquid'), 'utf8')
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '').replace(/\{%-?[\s\S]*?-?%\}/g, '').replace('data-hw-kaart ', 'data-hw-kaart data-demo="1" ').replace(/data-api="[^"]*"/, `data-api="${BASE}"`)
    .replace(/data-google-key="[^"]*"/, 'data-google-key=""');
  const script = `<script>(function(){
var CITIES=${JSON.stringify(MOCK_CITIES)}, COUNTRY='Nederland', API=${JSON.stringify(BASE)};
var btn=document.getElementById('mk-go'), all=document.getElementById('mk-all'), list=document.getElementById('mk-list'), st=document.getElementById('mk-st'), made=[];
function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
function ready(){return new Promise(function(ok){(function t(){var k=window.__hwKaart; if(k&&k.getMap()) ok(k); else setTimeout(t,300);})();});}
function slug(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
btn.onclick=function(){ btn.disabled=true; ready().then(function(k){ var chain=Promise.resolve();
  CITIES.forEach(function(c,i){ chain=chain.then(function(){
    st.textContent='Bezig: '+c[0]+' ('+(i+1)+'/'+CITIES.length+')';
    var W=k.getMap().getContainer().clientWidth||400, z=Math.log2(78271.5*Math.cos(c[2]*Math.PI/180)*W/(c[3]*1000));
    k.pick({lng:c[1],lat:c[2],city:c[0],country:COUNTRY,zoom:z});
    return wait(2500).then(function(){return k.buildAndUpload();}).then(function(r){
      return fetch(API+'/api/map/mockup/'+r.job_id+'.webp').then(function(x){ if(!x.ok) throw new Error('mockup'); return x.blob(); });
    }).then(function(b){ var u=URL.createObjectURL(b), name='landkaart-tegeltje-'+slug(c[0])+'.webp';
      made.push({u:u,name:name}); var d=document.createElement('div'); d.style.cssText='width:31%;min-width:160px';
      d.innerHTML='<img src="'+u+'" style="width:100%;border-radius:6px"><a download="'+name+'" href="'+u+'" style="display:block;font-size:13px;margin-top:4px">'+c[0]+' downloaden</a>'; list.appendChild(d);
    }).catch(function(e){ var d=document.createElement('div'); d.textContent=c[0]+': mislukt ('+(e&&e.message||e)+')'; d.style.color='#b00'; list.appendChild(d); });
  });});
  return chain; }).then(function(){ st.textContent='Klaar: '+made.length+' van '+CITIES.length+' gemaakt.'; all.hidden=!made.length; btn.disabled=false; }); };
all.onclick=function(){ made.reduce(function(p,m){ return p.then(function(){ var a=document.createElement('a'); a.href=m.u; a.download=m.name; document.body.appendChild(a); a.click(); a.remove(); return wait(400); }); },Promise.resolve()); };
})();</script>`;
  const ui = '<div style="margin:16px 0"><button id="mk-go" style="padding:12px 18px;font:600 15px inherit;font-family:inherit;cursor:pointer">Maak alle tegel-mockups (' + MOCK_CITIES.length + ' steden)</button> <button id="mk-all" hidden style="padding:12px 18px;font:600 15px inherit;font-family:inherit;cursor:pointer">Alles downloaden</button><div id="mk-st" style="margin:8px 0;font-size:14px"></div><div id="mk-list" style="display:flex;flex-wrap:wrap;gap:12px"></div></div>';
  res.set({ 'X-Robots-Tag': 'noindex', 'Access-Control-Allow-Origin': '*' }).type('html').send(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Tegel-mockups</title><style>body{font-family:Montserrat,system-ui,sans-serif;max-width:900px;margin:20px auto;padding:0 12px}.mkw{max-width:420px;opacity:.5}</style></head><body>${ui}<div class="mkw">${widget}</div>${script}</body></html>`);
});

// Eenvoudige botfilter: geen/zeer korte user-agent of bekende scripts/headless-browsers.
function looksLikeBot(req) {
  const ua = String(req.headers['user-agent'] || '');
  return ua.length < 15 || /bot|crawl|spider|curl|wget|python|httpclient|axios|node-fetch|go-http|java\/|headless|phantom|puppeteer|playwright|selenium/i.test(ua);
}
const validClient = (c) => /^[A-Za-z0-9_-]{8,64}$/.test(String(c || ''));
function parseVariants(j) { try { return JSON.parse(j.variants_json || '[]'); } catch { return []; } }

// De klant kiest één van de varianten; pas daarna is er een afbeelding voor de bestelling.
app.post('/api/jobs/:id/choose', async (req, res) => {
  const { client_id: clientId, index } = req.body || {};
  if (!validClient(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
  const j = db.prepare("SELECT j.*, d.name design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id WHERE j.id=? AND j.client_id=? AND j.status='done'").get(req.params.id, clientId);
  if (!j) return res.status(404).json({ error: 'Niet gevonden' });
  const v = parseVariants(j)[parseInt(index, 10)];
  if (!v || v.deleted) return res.status(400).json({ error: 'Deze keuze bestaat niet.' });
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
    error: j.status === 'error' ? (/content_policy|content checker/i.test(j.error || '') ? 'Deze foto kon helaas niet worden verwerkt. Probeer een andere foto of kies een andere uitsnede. Dit kost je geen poging.' : 'Het maken van de afbeelding is mislukt. Probeer het opnieuw.') : null,
    variants: parseVariants(j).map((v) => (v.deleted ? { deleted: true, preview_url: null } : { preview_url: fileUrl(v.preview_file) })),
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
    WHERE j.client_id=? AND j.status='done' AND j.profile=? AND j.print_file IS NOT NULL AND COALESCE(j.deleted,0)=0 ORDER BY j.created_at DESC LIMIT 6`).all(req.query.client_id, profile);
  res.json({ items: rows.filter((j) => fs.existsSync(path.join(FILES, j.print_file))).map(jobCard) });
});
// Recente pogingen van deze klant (alle niet-verwijderde varianten), zodat ze na een refresh van de pagina blijven staan.
app.get('/api/recent', (req, res) => {
  if (!validClient(req.query.client_id)) return res.json({ items: [] });
  const profile = req.query.profile === 'poster' ? 'poster' : 'tegel';
  const rows = db.prepare(`SELECT j.*, d.name design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id
    WHERE j.client_id=? AND j.status='done' AND j.profile=? AND COALESCE(j.deleted,0)=0 AND j.created_at>=datetime('now','-7 days') ORDER BY j.created_at DESC LIMIT 10`).all(req.query.client_id, profile);
  const items = rows.map((j) => {
    const vs = parseVariants(j).map((v) => (v.deleted || !v.preview_file || !fs.existsSync(path.join(FILES, v.preview_file)) ? { deleted: true, preview_url: null } : { preview_url: fileUrl(v.preview_file) }));
    return { job_id: j.id, design_id: j.design_id, design: j.design_name, chosen: j.chosen, created_at: j.created_at, variants: vs };
  }).filter((it) => it.variants.some((v) => !v.deleted));
  res.json({ items: items.reverse() });
});
// Klant verwijdert één van de twee zojuist gemaakte varianten (voordat er gekozen is). Zijn alle varianten weg, dan is de poging weg.
app.post('/api/jobs/:id/variants/:index/delete', (req, res) => {
  const clientId = (req.body || {}).client_id;
  if (!validClient(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
  const j = db.prepare("SELECT * FROM jobs WHERE id=? AND client_id=? AND status='done'").get(req.params.id, clientId);
  if (!j) return res.status(404).json({ error: 'Niet gevonden' });
  const all = parseVariants(j), i = parseInt(req.params.index, 10);
  const v = all[i];
  if (!v || v.deleted) return res.status(404).json({ error: 'Niet gevonden' });
  const hasChoice = j.chosen !== null && j.chosen !== undefined;
  const wasChosen = hasChoice && j.chosen === i;
  // Bij een poging waaruit al gekozen is, blijft het drukbestand bewaard (kan al besteld zijn); de klant ziet de variant niet meer.
  [[FILES, v.preview_file], ...(hasChoice ? [] : [[FILES, v.print_file]]), [ORIGINALS, v.raw_file]].forEach(([dir, f]) => { if (f && !wasChosen) fs.rmSync(path.join(dir, f), { force: true }); });
  all[i] = hasChoice ? { deleted: true, print_file: v.print_file, preview_file: wasChosen ? v.preview_file : undefined } : { deleted: true };
  if (wasChosen) db.prepare('UPDATE jobs SET chosen=NULL, preview_file=NULL, print_file=NULL WHERE id=?').run(j.id); // uit "Herbestelling" en de keuze
  const left = all.filter((x) => !x.deleted).length;
  db.prepare('UPDATE jobs SET variants_json=?, deleted=? WHERE id=?').run(JSON.stringify(all), left || hasChoice ? 0 : 1, j.id);
  res.json({ ok: true, left });
});

// Klant verwijdert een gemaakt ontwerp uit zijn lijst. Het gekozen bestand blijft bewaard (een lopende bestelling kan er nog naar verwijzen);
// de niet-gekozen varianten worden direct van de server gewist.
app.post('/api/jobs/:id/delete', (req, res) => {
  const clientId = (req.body || {}).client_id;
  if (!validClient(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
  const j = db.prepare("SELECT * FROM jobs WHERE id=? AND client_id=?").get(req.params.id, clientId);
  if (!j) return res.status(404).json({ error: 'Niet gevonden' });
  parseVariants(j).forEach((v, i) => {
    if (i === j.chosen) return;
    [[FILES, v.preview_file], [FILES, v.print_file], [ORIGINALS, v.raw_file]].forEach(([dir, f]) => { if (f) fs.rmSync(path.join(dir, f), { force: true }); });
  });
  db.prepare('UPDATE jobs SET deleted=1 WHERE id=?').run(j.id);
  res.json({ ok: true });
});

app.post('/api/reuse', (req, res) => {
  const { job_id: jobId, client_id: clientId } = req.body || {};
  if (!validClient(clientId)) return res.status(400).json({ error: 'Ongeldige sessie.' });
  const j = db.prepare("SELECT j.*, d.name design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id WHERE j.id=? AND j.client_id=? AND j.status='done' AND COALESCE(j.deleted,0)=0").get(String(jobId || ''), clientId);
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

const adminDesign = (d) => ({ ...d, example_url: fileUrl(d.example_file), ref_url: d.ref_file ? `/admin/api/designs/${d.id}/reference?v=${encodeURIComponent(d.ref_file)}` : '' });

// Originele klantfoto: alleen voor de beheerder (staat achter adminAuth), als verkleind plaatje.
app.get('/admin/api/jobs/:id/original', async (req, res) => {
  try {
    const j = db.prepare('SELECT original_file FROM jobs WHERE id=?').get(String(req.params.id || ''));
    const f = j && j.original_file ? path.join(ORIGINALS, path.basename(j.original_file)) : null;
    if (!f || !fs.existsSync(f)) return res.status(404).json({ error: 'Origineel niet (meer) beschikbaar.' });
    const buf = req.query.full ? fs.readFileSync(f) : await sharp(f).resize(400, 400, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
    res.set({ 'Cache-Control': 'private, max-age=300', 'Content-Type': 'image/jpeg', 'X-Robots-Tag': 'noindex' }).send(buf);
  } catch (e) { res.status(500).json({ error: 'Kon het origineel niet laden.' }); }
});

// Alle generaties doorzoeken: periode (UTC-tijden, de browser rekent om), stijl, status, tekst.
app.get('/admin/api/jobs', (req, res) => {
  const w = ['1=1']; const a = [];
  const ts = (v) => (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(v)) ? String(v).replace('T', ' ').slice(0, 19) : null);
  const from = ts(req.query.from), to = ts(req.query.to);
  if (from) { w.push('j.created_at >= ?'); a.push(from.length === 16 ? from + ':00' : from); }
  if (to) { w.push('j.created_at <= ?'); a.push(to.length === 16 ? to + ':59' : to); }
  if (parseInt(req.query.design, 10)) { w.push('j.design_id = ?'); a.push(parseInt(req.query.design, 10)); }
  const st = String(req.query.status || '');
  if (st === 'ordered') w.push("j.order_name IS NOT NULL AND j.order_name != ''");
  else if (st === 'chosen') w.push('j.chosen IS NOT NULL');
  else if (st === 'error') w.push("j.status = 'error'");
  else if (st === 'done') w.push("j.status = 'done'");
  const q = String(req.query.q || '').trim();
  if (q) { w.push("(j.custom_text LIKE ? OR j.ip LIKE ? OR j.id LIKE ? OR j.order_name LIKE ?)"); a.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const where = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM jobs j WHERE ${where}`).get(...a).c;
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const rows = db.prepare(`SELECT j.*, COALESCE(d.name, CASE WHEN j.profile='kaart' THEN 'Landkaart' END) design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id WHERE ${where} ORDER BY j.created_at DESC LIMIT 60 OFFSET ?`).all(...a, offset)
    .map((j) => {
      const vs = parseVariants(j);
      return { id: j.id, created_at: j.created_at, status: j.status, error: j.error, design_name: j.design_name, profile: j.profile, custom_text: j.custom_text, ip: j.ip, country: j.country,
        chosen: j.chosen, print_w: j.print_w, print_h: j.print_h, order_name: j.order_name || '',
        variants: vs.map((v, i) => ({ i, deleted: !!v.deleted, preview_url: fileUrl(v.preview_file), print_url: fileUrl(v.print_file) })),
        preview_url: fileUrl(j.preview_file), print_url: fileUrl(j.print_file),
        original_url: j.original_file && fs.existsSync(path.join(ORIGINALS, path.basename(j.original_file))) ? `/admin/api/jobs/${j.id}/original` : null };
    });
  res.json({ total, offset, jobs: rows });
});

app.get('/admin/api/state', (req, res) => {
  res.json({
    designs: db.prepare('SELECT * FROM designs ORDER BY sort, id').all().map(adminDesign),
    settings: allSettings(),
    has_fal_key: !!process.env.FAL_KEY,
    activity: activity(),
    recent: db.prepare("SELECT j.*, COALESCE(d.name, CASE WHEN j.profile='kaart' THEN 'Landkaart' END) design_name FROM jobs j LEFT JOIN designs d ON d.id=j.design_id ORDER BY j.created_at DESC LIMIT 30").all()
      .map((j) => { const v0 = parseVariants(j)[0] || {}; return { ...j, preview_url: fileUrl(j.preview_file || v0.preview_file), print_url: fileUrl(j.print_file || v0.print_file), variants: parseVariants(j).length }; }),
  });
});

// Activiteit per IP in de laatste 24 uur, met markering van verdachte patronen.
function activity() {
  const rows = db.prepare(`SELECT ip, COUNT(*) n, COUNT(DISTINCT client_id) clients, MIN(created_at) first, MAX(created_at) last, MAX(ua) ua, MAX(country) country,
      SUM(status='error') errors FROM jobs WHERE client_id!='admin-test' AND created_at > datetime('now','-1 day') GROUP BY ip ORDER BY n DESC LIMIT 25`).all();
  return rows.map((r) => {
    const flags = [];
    if (r.clients >= 3) flags.push(`${r.clients} verschillende browsers vanaf 1 IP`);
    if (r.n >= 8) flags.push(`${r.n} pogingen in 24 uur`);
    if (!r.ua || /bot|curl|python|headless|wget|axios|node/i.test(r.ua)) flags.push('verdachte user-agent');
    if (r.country && !['NL', 'BE', 'DE', 'LU', 'FR', ''].includes(r.country)) flags.push('land ' + r.country);
    return { ...r, flags };
  });
}

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
app.post('/admin/api/designs/:id/reference', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen bestand' });
  const name = `ref-${rid()}.jpg`;
  fs.writeFileSync(path.join(ORIGINALS, name), await sharp(req.file.buffer).rotate().flatten({ background: '#ffffff' }).resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer());
  const old = db.prepare('SELECT ref_file FROM designs WHERE id=?').get(req.params.id);
  if (old && old.ref_file) fs.rmSync(path.join(ORIGINALS, old.ref_file), { force: true });
  db.prepare('UPDATE designs SET ref_file=? WHERE id=?').run(name, req.params.id);
  res.json({ ok: true });
});
app.get('/admin/api/designs/:id/reference', (req, res) => {
  const d = db.prepare('SELECT ref_file FROM designs WHERE id=?').get(req.params.id);
  if (!d || !d.ref_file) return res.status(404).end();
  res.sendFile(path.join(ORIGINALS, d.ref_file));
});
app.delete('/admin/api/designs/:id/reference', (req, res) => {
  const d = db.prepare('SELECT ref_file FROM designs WHERE id=?').get(req.params.id);
  if (d && d.ref_file) fs.rmSync(path.join(ORIGINALS, d.ref_file), { force: true });
  db.prepare("UPDATE designs SET ref_file='' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
// Routes beheren: GPX uploaden, naam en volgorde aanpassen, verbergen of verwijderen.
app.get('/admin/api/routes', (req, res) => {
  res.json({ routes: db.prepare('SELECT id, name, sport, place, country, distance_km, active, sort, created_at FROM routes ORDER BY sort, name').all() });
});
const cleanRt = (v) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 40);
app.post('/admin/api/routes', upload.single('gpx'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Kies een GPX-bestand.' });
    const pts = routesLib.parseGpx(req.file.buffer.toString('utf8'));
    if (pts.length < 5) return res.status(400).json({ error: 'In dit bestand zitten geen routepunten (GPX verwacht).' });
    const name = String(req.body.name || req.file.originalname.replace(/\.gpx$/i, '')).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Geef de route een naam.' });
    const simple = routesLib.simplify(pts, 3, 2500);
    const id = rid();
    db.prepare('INSERT INTO routes(id,name,sport,place,country,distance_km,points_json,sort) VALUES(?,?,?,?,?,?,?,?)').run(id, name, cleanRt(req.body.sport), cleanRt(req.body.place), cleanRt(req.body.country), routesLib.distanceKm(pts), JSON.stringify(simple), parseInt(req.body.sort, 10) || 0);
    res.json({ id, name, distance_km: Math.round(routesLib.distanceKm(pts) * 10) / 10, points: pts.length, saved_points: simple.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Route opslaan mislukt.' }); }
});
app.put('/admin/api/routes/:id', (req, res) => {
  const b = req.body || {}, r = db.prepare('SELECT id FROM routes WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Niet gevonden' });
  if (typeof b.name === 'string' && b.name.trim()) db.prepare('UPDATE routes SET name=? WHERE id=?').run(b.name.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 80), r.id);
  for (const k of ['sport', 'place', 'country']) if (typeof b[k] === 'string') db.prepare(`UPDATE routes SET ${k}=? WHERE id=?`).run(cleanRt(b[k]), r.id);
  if (b.active !== undefined) db.prepare('UPDATE routes SET active=? WHERE id=?').run(b.active ? 1 : 0, r.id);
  if (b.sort !== undefined) db.prepare('UPDATE routes SET sort=? WHERE id=?').run(parseInt(b.sort, 10) || 0, r.id);
  res.json({ ok: true });
});
app.delete('/admin/api/routes/:id', (req, res) => { db.prepare('DELETE FROM routes WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.put('/admin/api/settings', (req, res) => {
  const LIMITS = { tegel_px: [400, 6000], poster_long_px: [800, 10000] };   // voorkomt vergissingen die de server vastlopen
  for (const k of Object.keys(allSettings())) {
    if (req.body[k] === undefined) continue;
    let v = req.body[k];
    if (LIMITS[k]) { const n = parseInt(v, 10); if (!Number.isFinite(n)) continue; v = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], n)); }
    setSetting(k, v);
  }
  res.json(allSettings());
});
// Testknop: genereert zonder poginglimiet.
app.post('/admin/api/test', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen foto' });
  const id = rid();
  const originalFile = `${id}.jpg`;
  fs.writeFileSync(path.join(ORIGINALS, originalFile), await sharp(req.file.buffer).rotate().jpeg({ quality: 95 }).toBuffer());
  db.prepare('INSERT INTO jobs(id,client_id,ip,design_id,profile,orientation,original_file) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'admin-test', clientIp(req), parseInt(req.body.design_id, 10), req.body.profile === 'poster' ? 'poster' : 'tegel',
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
  app.listen(port, () => { console.log('AI-foto service op poort', port); resume(); seedRoutes(); });
}
module.exports = app;
