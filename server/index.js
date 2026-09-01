require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const { listOrders, getOrder, updateStatus, updateStatusBulk, getAllOrdersRaw, updateDerivedFields, deleteOldOrders, getInventory, setInventoryStock, addInventoryItem, deleteInventoryItem, getOrdersReadyForReviewEmail, markReviewEmailSent, setSizeOverride, setNote, db } = require('./db');
const { syncOrders, mapOrder, extractFotoTegelPhotoUrls, extractPosterlyPhotoUrls, extractTileItemsFromOrder, extractAutoFrameItemsFromOrder } = require('./shopify');
const axios = require('axios');
const archiver = require('archiver');
const { imageBufferToPrintPdf, cropPosterlyCanvas } = require('./printfile');
const { generateMusicFramePdf, extractMusicFrameItemsFromOrder } = require('./musicframe');
const { generateAutoFramePdf } = require('./autoframe');
const { generateTegelTekstPdf, extractTegelTekstItemsFromOrder } = require('./texttile');
const { sendReviewEmail } = require('./reviewEmail');
const SqliteSessionStore = require('./sqliteSessionStore');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, '..', 'public');

// Geeft de datum van VANDAAG terug als "YYYY-MM-DD", in de Nederlandse
// tijdzone (Europe/Amsterdam) — dus NIET zomaar new Date().toISOString(),
// want die geeft de UTC-datum van de server, die (afhankelijk van zomer-/
// wintertijd) 1-2 uur achterloopt op Nederlandse tijd. Rond middernacht kan
// dat verschil de datum zelf laten omslaan (bv. om 00:30 's nachts is het in
// Nederland al de volgende dag, maar in UTC nog niet) — precies het probleem
// waar de mapnamen van geëxporteerde drukwerkbestanden last van hadden.
function getDutchDateString(datum = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return formatter.format(datum); // en-CA geeft toevallig precies het YYYY-MM-DD-formaat
}

if (!process.env.AUTH_USER || !process.env.AUTH_PASS) {
  console.warn('WAARSCHUWING: AUTH_USER / AUTH_PASS niet ingesteld in .env — stel deze in voor je live gaat!');
}
if (!process.env.PAKBON_USER || !process.env.PAKBON_PASS) {
  console.warn('LET OP: PAKBON_USER / PAKBON_PASS niet ingesteld in .env — het aparte pakbon-account werkt dan nog niet.');
}

// Zonder eigen SESSION_SECRET in .env wordt er bij elke herstart een nieuwe
// gegenereerd — dat betekent dat iedereen na een herstart opnieuw moet
// inloggen. Zet SESSION_SECRET in .env (een willekeurige lange string) als je
// wil dat mensen ingelogd blijven na een herstart van de server.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(session({
  store: new SqliteSessionStore(db),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 dagen ingelogd blijven
  }
}));
app.use(express.json());

// --- Publiek toegankelijk: het inlogscherm + de bestanden die dat scherm zelf nodig heeft ---
app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/logo.svg', (req, res) => res.sendFile(path.join(publicDir, 'logo.svg')));
app.get('/style.css', (req, res) => res.sendFile(path.join(publicDir, 'style.css')));
// Favicon/app-icoon-bestanden: browsers vragen deze automatisch op bij ELKE
// pagina (dus ook het inlogscherm, nog vóórdat je bent ingelogd).
['/favicon.ico', '/favicon-16x16.png', '/favicon-32x32.png', '/apple-touch-icon.png',
 '/android-chrome-192x192.png', '/android-chrome-512x512.png', '/site.webmanifest'
].forEach(route => {
  app.get(route, (req, res) => res.sendFile(path.join(publicDir, route.slice(1))));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const adminUser = process.env.AUTH_USER || 'admin';
  const adminPass = process.env.AUTH_PASS || 'change-me';
  const pakbonUser = process.env.PAKBON_USER;
  const pakbonPass = process.env.PAKBON_PASS;

  if (username === adminUser && password === adminPass) {
    req.session.authenticated = true;
    req.session.role = 'admin';
    return res.json({ ok: true, role: 'admin' });
  }
  if (pakbonUser && username === pakbonUser && password === pakbonPass) {
    req.session.authenticated = true;
    req.session.role = 'pakbon';
    return res.json({ ok: true, role: 'pakbon' });
  }
  res.status(401).json({ error: 'Onjuiste gebruikersnaam of wachtwoord' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Geeft de huidige rol terug, zodat het dashboard bepaalde knoppen/functies
// (zoals drukwerkbestanden downloaden) kan verbergen voor het pakbon-account.
app.get('/api/session', (req, res) => {
  if (!req.session || !req.session.authenticated) return res.status(401).json({ error: 'Niet ingelogd' });
  res.json({ role: req.session.role || 'admin' });
});

// --- Alles hierna vereist een ingelogde sessie ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Niet ingelogd' });
  }
  return res.redirect('/login');
}
// Extra check voor functies die alleen het admin-account mag gebruiken
// (bv. drukwerkbestanden downloaden) — het pakbon-account krijgt hier een
// nette foutmelding op i.p.v. toegang.
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Deze functie is alleen beschikbaar voor het admin-account.' });
}
app.use(requireAuth);

app.use(express.static(publicDir));

// --- API: orders ---
app.get('/api/orders', (req, res) => {
  try {
    const orders = listOrders(req.query.status || null).map(o => ({
      ...o,
      line_items: JSON.parse(o.line_items_json || '[]'),
      spotify_links: JSON.parse(o.spotify_links_json || '[]'),
      photo_links: JSON.parse(o.photo_links_json || '[]')
    }));
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  const lineItems = JSON.parse(order.line_items_json || '[]');
  res.json({
    ...order,
    line_items: lineItems,
    spotify_links: JSON.parse(order.spotify_links_json || '[]'),
    photo_links: JSON.parse(order.photo_links_json || '[]'),
    // Welke van de photo_links een "Gepersonaliseerde foto tegel"-upload is
    // (die dus ook een drukwerkbestand-knop mag krijgen, i.p.v. alleen
    // "download origineel") — zie extractFotoTegelPhotoUrls in shopify.js.
    foto_tegel_links: extractFotoTegelPhotoUrls(lineItems),
    // Idem, maar dan voor Posterly-orders (die krijgen bovendien nog een
    // crop-stap, zie cropPosterlyCanvas in printfile.js).
    posterly_links: extractPosterlyPhotoUrls(lineItems),
    // Alle tegel-achtige links (autopictura/foto-tegel/posterly) MET het
    // formaat al per-regel correct bepaald — voorkomt dat de popup zelf
    // moet gokken en daarbij per ongeluk 1 regel-formaat op de hele order
    // toepast (zie ook extractTileItemsFromOrder in shopify.js).
    tile_items: extractTileItemsFromOrder(lineItems),
    // Auto-frame-items in deze order (voor de downloadknop in de popup)
    autoframe_items: extractAutoFrameItemsFromOrder({ line_items: lineItems }),
    // "Tegeltje met tekst"-items met een bekend ontwerp (voor de downloadknop in de popup)
    texttile_items: extractTegelTekstItemsFromOrder({ line_items: lineItems })
  });
});

app.post('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is verplicht' });
  const order = updateStatus(req.params.id, status);
  res.json(order);
});

// --- Handmatige formaat-override (10x10 <-> 13x13) voor tegeltjes, bv. als
// een klant achteraf toch een ander formaat wil. Werkt door in zowel het
// drukwerkbestand als de pakbon — zie de "size_override"-check in
// appendPrintFilesToArchive hieronder en buildReceiptHtml in public/app.js. ---
app.post('/api/orders/:id/size-override', (req, res) => {
  const { override } = req.body; // '10x10' | '13x13' | null
  if (override !== null && override !== '10x10' && override !== '13x13') {
    return res.status(400).json({ error: "override moet '10x10', '13x13' of null zijn" });
  }
  const order = setSizeOverride(req.params.id, override);
  res.json(order);
});

// --- Vrij notitieveld per order — verschijnt ook onderaan op de pakbon als
// 'm is ingevuld (zie buildReceiptHtml in public/app.js). ---
app.post('/api/orders/:id/note', (req, res) => {
  const { note } = req.body;
  const order = setNote(req.params.id, note);
  res.json(order);
});

// --- Bulk statuswijziging: meerdere orders tegelijk naar een andere status zetten ---
app.post('/api/orders/bulk-status', (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids (array) is verplicht' });
  if (!status) return res.status(400).json({ error: 'status is verplicht' });
  const updated = updateStatusBulk(ids, status);
  res.json({ updated });
});

// --- Handmatige sync trigger ---
app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncOrders();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Alle afgeleide velden (adres, klantgegevens, items, Spotify/foto-links)
// herberekenen voor ALLE bestaande orders, lokaal, zonder opnieuw bij Shopify
// op te vragen. Handig na een verbetering aan de mapping/detectielogica,
// zodat oudere orders (die de incrementele sync niet opnieuw ophaalt) alsnog
// de nieuwste versie krijgen. De status van elke order blijft ongewijzigd. ---
app.post('/api/reprocess-links', (req, res) => {
  try {
    const rows = getAllOrdersRaw();
    let updated = 0;
    let skipped = 0;

    rows.forEach(row => {
      if (!row.raw_json || row.raw_json === '{}') { skipped++; return; } // testorders zonder echte Shopify-data overslaan
      let order;
      try {
        order = JSON.parse(row.raw_json);
      } catch (e) {
        skipped++;
        return;
      }
      const mapped = mapOrder(order);
      updateDerivedFields(row.id, mapped);
      updated++;
    });

    res.json({ updated, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Spotify Code: genereert een scanbare Spotify code afbeelding voor een link/uri ---
app.get('/api/spotify-code', (req, res) => {
  const link = req.query.link;
  if (!link) return res.status(400).json({ error: 'link is verplicht' });

  // Zet een open.spotify.com URL om naar een spotify: URI voor de Scannables service
  let uri = link.trim();
  const match = uri.match(/open\.spotify\.com\/(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/);
  if (match) {
    uri = `spotify:${match[1]}:${match[2]}`;
  }

  const encoded = encodeURIComponent(uri);
  // Officiële Spotify Scannables image service (geen API key nodig, publiek endpoint)
  const imageUrl = `https://scannables.scdn.co/uri/plain/png/000000/white/640/${encoded}`;
  res.json({ imageUrl, uri });
});

// --- QR code: genereert een QR code afbeelding (PNG, base64) voor een willekeurige link ---
app.get('/api/qr-code', async (req, res) => {
  const data = req.query.data;
  if (!data) return res.status(400).json({ error: 'data is verplicht' });
  try {
    const dataUrl = await QRCode.toDataURL(data, { width: 400, margin: 1 });
    res.json({ imageUrl: dataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Spotify Code als downloadbaar SVG-bestand: witte achtergrond, zwarte streepjes ---
app.get('/api/spotify-code-svg', async (req, res) => {
  const link = req.query.link;
  if (!link) return res.status(400).json({ error: 'link is verplicht' });

  let uri = link.trim();
  const match = uri.match(/open\.spotify\.com\/(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/);
  if (match) {
    uri = `spotify:${match[1]}:${match[2]}`;
  }

  const encoded = encodeURIComponent(uri);
  // Witte achtergrond, zwarte code — Scannables service, svg formaat
  const svgUrl = `https://scannables.scdn.co/uri/plain/svg/ffffff/black/640/${encoded}`;

  try {
    const response = await axios.get(svgUrl, { responseType: 'text' });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(response.data);
  } catch (e) {
    res.status(500).json({ error: 'Kon Spotify code niet genereren: ' + e.message });
  }
});

// --- QR code als downloadbaar SVG-bestand ---
app.get('/api/qr-code-svg', async (req, res) => {
  const data = req.query.data;
  if (!data) return res.status(400).json({ error: 'data is verplicht' });
  try {
    const svg = await QRCode.toString(data, { type: 'svg', width: 400, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Voorraad ---
app.get('/api/inventory', (req, res) => {
  try {
    res.json(getInventory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/inventory', (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items (array) is verplicht' });
    items.forEach(item => {
      const stock = parseInt(item.stock, 10);
      if (item.id && !isNaN(stock)) setInventoryStock(item.id, stock);
    });
    res.json(getInventory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/inventory/add', (req, res) => {
  try {
    const { name, stock } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Naam is verplicht' });
    const stockNum = parseInt(stock, 10) || 0;
    const created = addInventoryItem(name, stockNum);
    if (!created) return res.status(409).json({ error: 'Er bestaat al een voorraadartikel met deze naam' });
    res.json(getInventory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/inventory/:id', (req, res) => {
  try {
    deleteInventoryItem(req.params.id);
    res.json(getInventory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Fotopreview-proxy: haalt een klantfoto server-side op i.p.v. dat elke
// computer/browser deze zelf rechtstreeks bij autopictura/Shopify ophaalt.
// Dit voorkomt dat de foto op sommige computers/netwerken niet laadt (bv.
// door CORS- of hotlink-beperkingen bij de externe dienst), en zorgt dat de
// pakbon overal betrouwbaar de besteldfoto toont. ---
app.get('/api/photo-preview', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url is verplicht' });

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: 'Ongeldige url.' });
  }
  // Alleen https, en geen lokale/interne adressen (simpele bescherming tegen misbruik)
  if (parsed.protocol !== 'https:' || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.)/i.test(parsed.hostname)) {
    return res.status(400).json({ error: 'Deze url wordt niet ondersteund voor fotopreviews.' });
  }

  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(response.data);
  } catch (e) {
    res.status(502).json({ error: 'Kon de foto niet ophalen: ' + e.message });
  }
});

// --- Download proxy: haalt een externe foto/bestand op en dwingt een download af in de browser ---
app.get('/api/download', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url is verplicht' });
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    const extension = (contentType.split('/')[1] || 'bin').split(';')[0];
    let filename = 'bestand';
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'bestand');
    } catch (e) { /* val terug op default naam */ }
    if (!filename.includes('.')) filename += `.${extension}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(response.data);
  } catch (e) {
    res.status(500).json({ error: 'Kon bestand niet ophalen: ' + e.message });
  }
});

// --- Eén drukwerkbestand (PDF) downloaden op het juiste formaat — alleen voor autopictura-links ---
app.get('/api/print-files/single-pdf', requireAdmin, async (req, res) => {
  const link = req.query.link;
  const widthCm = parseFloat(req.query.widthCm) || 10;
  const heightCm = parseFloat(req.query.heightCm) || 10;
  const filename = (req.query.filename || 'drukwerkbestand.pdf').replace(/[\\/:*?"<>|]/g, '-');

  if (!link) return res.status(400).json({ error: 'link is verplicht' });
  if (!/autopictura/i.test(link) && !/cdn\.shopify\.com/i.test(link) && !/posterlyapp\.io/i.test(link)) {
    return res.status(400).json({ error: 'Dit endpoint is alleen voor autopictura-links, Shopify CDN-foto-uploads, of Posterly-links.' });
  }

  try {
    const imgRes = await axios.get(link, { responseType: 'arraybuffer' });
    let imageBuffer = Buffer.from(imgRes.data);
    // Posterly-foto's bevatten nog canvas/rand — eerst uit het midden
    // bijknippen naar het exacte gevraagde formaat.
    if (/posterlyapp\.io/i.test(link)) {
      imageBuffer = await cropPosterlyCanvas(imageBuffer, Math.max(widthCm, heightCm) * 10); // cm -> mm
    }
    const pdfContent = await imageBufferToPrintPdf(imageBuffer, { widthCm, heightCm, dpi: 300 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfContent);
  } catch (e) {
    res.status(500).json({ error: 'Kon drukwerkbestand niet genereren: ' + e.message });
  }
});

// --- Eén Muziek-/Valentijnframe-drukwerkbestand downloaden vanuit de order-popup ---
app.get('/api/print-files/musicframe-pdf', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.query.orderId, 10);
  const itemIndex = parseInt(req.query.itemIndex, 10) || 0;
  if (!orderId) return res.status(400).json({ error: 'orderId is verplicht' });

  try {
    const order = getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });

    const lineItems = JSON.parse(order.line_items_json || '[]');
    const items = extractMusicFrameItemsFromOrder({ line_items: lineItems });
    const item = items[itemIndex];
    if (!item) return res.status(404).json({ error: 'Geen Muziek-/Valentijnframe gevonden op deze order' });

    const pdfBytes = await generateMusicFramePdf(item.data);
    const baseName = String(order.order_number || order.shopify_order_id).replace(/[\\/:*?"<>|]/g, '-');
    const suffix = items.length > 1 ? ` ${itemIndex + 1}` : '';
    const variantSuffix = item.variant === 'dik' ? ' dik' : item.variant === 'klein' ? ' klein' : ' muziekframe';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}${suffix}${variantSuffix}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    res.status(500).json({ error: 'Kon muziekframe-bestand niet genereren: ' + e.message });
  }
});

// --- Eén "Tegeltje met tekst"-drukwerkbestand downloaden vanuit de order-popup ---
app.get('/api/print-files/texttile-pdf', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.query.orderId, 10);
  const itemIndex = parseInt(req.query.itemIndex, 10) || 0;
  if (!orderId) return res.status(400).json({ error: 'orderId is verplicht' });

  try {
    const order = getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });

    const lineItems = JSON.parse(order.line_items_json || '[]');
    const items = extractTegelTekstItemsFromOrder({ line_items: lineItems });
    const item = items[itemIndex];
    if (!item) return res.status(404).json({ error: 'Geen "Tegeltje met tekst" met bekend ontwerp gevonden op deze order' });

    const pdfBytes = await generateTegelTekstPdf(item.data);
    const baseName = String(order.order_number || order.shopify_order_id).replace(/[\\/:*?"<>|]/g, '-');
    const suffix = items.length > 1 ? ` ${itemIndex + 1}` : '';
    // Bestandsnaam bevat zowel het bestelnummer als de gekozen tegelkleur.
    const kleurSuffix = item.kleur ? ` ${item.kleur.replace(/[\\/:*?"<>|]/g, '-')}` : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}${suffix}${kleurSuffix}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    res.status(500).json({ error: 'Kon tegeltje-bestand niet genereren: ' + e.message });
  }
});

// --- Eén Auto-frame-drukwerkbestand downloaden vanuit de order-popup ---
app.get('/api/print-files/autoframe-pdf', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.query.orderId, 10);
  const itemIndex = parseInt(req.query.itemIndex, 10) || 0;
  if (!orderId) return res.status(400).json({ error: 'orderId is verplicht' });

  try {
    const order = getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });

    const lineItems = JSON.parse(order.line_items_json || '[]');
    const items = extractAutoFrameItemsFromOrder({ line_items: lineItems });
    const item = items[itemIndex];
    if (!item) return res.status(404).json({ error: 'Geen Auto-frame gevonden op deze order' });

    const pdfBytes = await generateAutoFramePdf(item.data);
    const baseName = String(order.order_number || order.shopify_order_id).replace(/[\\/:*?"<>|]/g, '-');
    const suffix = items.length > 1 ? ` ${itemIndex + 1}` : '';
    const variantSuffix = item.variant === 'dik' ? ' dik' : item.variant === 'klein' ? ' klein' : ' autoframe';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}${suffix}${variantSuffix}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    res.status(500).json({ error: 'Kon auto-frame-bestand niet genereren: ' + e.message });
  }
});

// --- Drukwerkbestanden (PDF) in 1x downloaden voor de GESELECTEERDE orders met een autopictura-link ---
app.get('/api/print-files/pdf-zip', requireAdmin, async (req, res) => {
  try {
    const idsParam = req.query.ids;
    if (!idsParam) {
      return res.status(400).json({ error: 'Geen orders geselecteerd. Selecteer eerst één of meer orders.' });
    }
    const selectedIds = String(idsParam).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (selectedIds.length === 0) {
      return res.status(400).json({ error: 'Geen geldige orders geselecteerd.' });
    }

    const selectedOrders = listOrders(null)
      .filter(o => selectedIds.includes(o.id))
      .map(o => ({
        ...o,
        line_items: JSON.parse(o.line_items_json || '[]'),
        photo_links: JSON.parse(o.photo_links_json || '[]')
      }));

    const targets = selectedOrders.filter(o =>
      o.photo_links.some(l => /autopictura/i.test(l)) ||
      extractMusicFrameItemsFromOrder({ line_items: o.line_items }).length > 0 ||
      extractFotoTegelPhotoUrls(o.line_items).length > 0 ||
      extractPosterlyPhotoUrls(o.line_items).length > 0 ||
      extractAutoFrameItemsFromOrder({ line_items: o.line_items }).length > 0 ||
      extractTegelTekstItemsFromOrder({ line_items: o.line_items }).length > 0
    );

    if (targets.length === 0) {
      return res.status(404).json({ error: 'Geen van de geselecteerde orders heeft een autopictura-link, Muziek-/Valentijnframe, Gepersonaliseerde foto tegel, Posterly-bestelling, of Auto-frame.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="tegeltjes.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    await appendPrintFilesToArchive(archive, targets);

    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Kernlogica van het genereren van drukwerkbestanden, herbruikt door zowel de
// hierboven staande downloadroute als de geplande automatische taak hieronder.
// Zet voor elke order met minstens 1 gelukt drukwerkbestand de status om naar
// "wacht op productie".
//
// Mapstructuur in de zip:
//   {datum}/tegels/1007.pdf
//   {datum}/tegels/groot/1007 groot.pdf
//   {datum}/tegels/gekleurd/1099 Marineblauw.pdf
//   {datum}/muziekframe/1055 muziekframe.pdf
//   {datum}/muziekframe/klein/1055 klein.pdf
//   {datum}/muziekframe/Dik/1055 dik.pdf
async function appendPrintFilesToArchive(archive, targets) {
  const dateFolder = getDutchDateString(); // YYYY-MM-DD, Nederlandse tijdzone

  for (const order of targets) {
    let orderSucceeded = false;

    // "Tegel-achtige" producten (autopictura, "Gepersonaliseerde foto tegel",
    // Posterly) met het formaat PER REGEL apart bepaald — belangrijk bij
    // orders met meerdere tegels van een verschillend formaat (bv. 1x 10x10
    // + 1x 13x13 in dezelfde order), anders zou de een de ander besmetten.
    const tileItems = extractTileItemsFromOrder(order.line_items);
    const baseName = String(order.order_number || order.shopify_order_id).replace(/[\\/:*?"<>|]/g, '-');

    if (tileItems.length > 0) {
      const multiple = tileItems.length > 1;

      for (let i = 0; i < tileItems.length; i++) {
        const tileItem = tileItems[i];
        // Handmatige override (geldt voor de HELE order) heeft voorrang;
        // anders het per-regel bepaalde formaat gebruiken.
        let is13x13;
        if (order.size_override === '13x13') {
          is13x13 = true;
        } else if (order.size_override === '10x10') {
          is13x13 = false;
        } else {
          is13x13 = tileItem.is13x13;
        }
        const sizeCm = is13x13 ? 13 : 10;

        // Bij meerdere links in dezelfde order: nummer achter het ordernummer (1, 2, ...)
        const numberSuffix = multiple ? ` ${i + 1}` : '';
        // 13x13-bestanden komen in een submap "groot" terecht, de rest direct in tegels/
        const filename = is13x13
          ? `${dateFolder}/tegels/groot/${baseName}${numberSuffix} groot.pdf`
          : `${dateFolder}/tegels/${baseName}${numberSuffix}.pdf`;

        try {
          const imgRes = await axios.get(tileItem.link, { responseType: 'arraybuffer' });
          let imageBuffer = Buffer.from(imgRes.data);
          // Posterly-foto's bevatten nog canvas/rand — eerst uit het midden
          // bijknippen naar het exacte gevraagde formaat, vóórdat 'm
          // beeldvullend in het drukwerkbestand terechtkomt.
          if (tileItem.isPosterly) {
            imageBuffer = await cropPosterlyCanvas(imageBuffer, sizeCm * 10); // cm -> mm
          }
          const pdfContent = await imageBufferToPrintPdf(imageBuffer, { widthCm: sizeCm, heightCm: sizeCm, dpi: 300 });
          archive.append(pdfContent, { name: filename });
          orderSucceeded = true;
        } catch (e) {
          archive.append(
            `Kon de afbeelding voor order ${baseName}${numberSuffix} niet ophalen/omzetten: ${e.message}`,
            { name: `${dateFolder}/tegels/FOUT-${baseName}${numberSuffix}.txt` }
          );
        }
      }
    }

    // --- Auto-frame: eigen drukwerkbestand per besteld exemplaar (zelfde
    // protocol als het muziekframe hierboven) ---
    const autoFrameItems = extractAutoFrameItemsFromOrder({ line_items: order.line_items });
    if (autoFrameItems.length > 0) {
      const multipleAutoFrames = autoFrameItems.length > 1;
      for (let i = 0; i < autoFrameItems.length; i++) {
        const numberSuffix = multipleAutoFrames ? ` ${i + 1}` : '';
        const item = autoFrameItems[i];
        let filename;
        if (item.variant === 'dik') {
          filename = `${dateFolder}/autoframe/Dik/${baseName}${numberSuffix} dik.pdf`;
        } else if (item.variant === 'klein') {
          filename = `${dateFolder}/autoframe/klein/${baseName}${numberSuffix} klein.pdf`;
        } else {
          filename = `${dateFolder}/autoframe/${baseName}${numberSuffix} autoframe.pdf`;
        }
        try {
          const pdfBytes = await generateAutoFramePdf(item.data);
          archive.append(Buffer.from(pdfBytes), { name: filename });
          orderSucceeded = true;
        } catch (e) {
          archive.append(
            `Kon het auto-frame-bestand voor order ${baseName}${numberSuffix} niet genereren: ${e.message}`,
            { name: `${dateFolder}/autoframe/FOUT-${baseName}${numberSuffix}-autoframe.txt` }
          );
        }
      }
    }

    // --- Muziek-/Valentijnframe: eigen drukwerkbestand per besteld exemplaar ---
    // Zelfde protocol als de tegeltjes (13x13 -> map "groot"): staat er "klein"
    // of "dik" bij de variant, dan komt het bestand in een eigen submap met
    // die naam in de bestandsnaam — verder blijft het formaat gewoon hetzelfde.
    const musicFrameItems = extractMusicFrameItemsFromOrder({ line_items: order.line_items });
    if (musicFrameItems.length > 0) {
      const multipleFrames = musicFrameItems.length > 1;
      for (let i = 0; i < musicFrameItems.length; i++) {
        const numberSuffix = multipleFrames ? ` ${i + 1}` : '';
        const item = musicFrameItems[i];
        let filename;
        if (item.variant === 'dik') {
          filename = `${dateFolder}/muziekframe/Dik/${baseName}${numberSuffix} dik.pdf`;
        } else if (item.variant === 'klein') {
          filename = `${dateFolder}/muziekframe/klein/${baseName}${numberSuffix} klein.pdf`;
        } else {
          filename = `${dateFolder}/muziekframe/${baseName}${numberSuffix} muziekframe.pdf`;
        }
        try {
          const pdfBytes = await generateMusicFramePdf(item.data);
          archive.append(Buffer.from(pdfBytes), { name: filename });
          orderSucceeded = true;
        } catch (e) {
          archive.append(
            `Kon het muziekframe-bestand voor order ${baseName}${numberSuffix} niet genereren: ${e.message}`,
            { name: `${dateFolder}/muziekframe/FOUT-${baseName}${numberSuffix}-muziekframe.txt` }
          );
        }
      }
    }

    // --- "Tegeltje met tekst": eigen drukwerkbestand per besteld exemplaar,
    // met bestelnummer + gekozen tegelkleur in de bestandsnaam. Komt net als
    // de 13x13-foto-tegels ("tegels/groot/") in een eigen submap onder de
    // bestaande "tegels/"-map te staan, i.p.v. een aparte hoofdmap. ---
    const tegelTekstItems = extractTegelTekstItemsFromOrder({ line_items: order.line_items });
    if (tegelTekstItems.length > 0) {
      const multipleTegels = tegelTekstItems.length > 1;
      for (let i = 0; i < tegelTekstItems.length; i++) {
        const numberSuffix = multipleTegels ? ` ${i + 1}` : '';
        const item = tegelTekstItems[i];
        const kleurSuffix = item.kleur ? ` ${item.kleur.replace(/[\\/:*?"<>|]/g, '-')}` : '';
        const filename = `${dateFolder}/tegels/gekleurd/${baseName}${numberSuffix}${kleurSuffix}.pdf`;
        try {
          const pdfBytes = await generateTegelTekstPdf(item.data);
          archive.append(Buffer.from(pdfBytes), { name: filename });
          orderSucceeded = true;
        } catch (e) {
          archive.append(
            `Kon het tegeltje-bestand voor order ${baseName}${numberSuffix} niet genereren: ${e.message}`,
            { name: `${dateFolder}/tegels/gekleurd/FOUT-${baseName}${numberSuffix}.txt` }
          );
        }
      }
    }

    // Order automatisch naar "wacht op productie" zetten zodra minstens 1 drukwerkbestand is gelukt
    if (orderSucceeded) {
      updateStatus(order.id, 'wacht op productie');
    }
  }
}

// --- Automatisch op doordeweekse dagen om 12:00 alle drukwerkbestanden verzamelen
// voor orders die op "wacht op drukwerkbestand" staan, en opslaan als zip-bestand
// in de map "exports" op de server (klaar om te openen, geen download-knop nodig). ---
async function runScheduledPrintFilesExport() {
  const allOrders = listOrders('wacht op drukwerkbestand').map(o => ({
    ...o,
    line_items: JSON.parse(o.line_items_json || '[]'),
    photo_links: JSON.parse(o.photo_links_json || '[]')
  }));
  const targets = allOrders.filter(o =>
    o.photo_links.some(l => /autopictura/i.test(l)) ||
    extractMusicFrameItemsFromOrder({ line_items: o.line_items }).length > 0 ||
    extractFotoTegelPhotoUrls(o.line_items).length > 0 ||
    extractPosterlyPhotoUrls(o.line_items).length > 0 ||
    extractAutoFrameItemsFromOrder({ line_items: o.line_items }).length > 0 ||
    extractTegelTekstItemsFromOrder({ line_items: o.line_items }).length > 0
  );

  if (targets.length === 0) {
    console.log('[auto-export] geen orders met status "wacht op drukwerkbestand" en een autopictura-link, Muziek-/Valentijnframe, Gepersonaliseerde foto tegel, Posterly-bestelling, of Auto-frame, niets te doen.');
    return;
  }

  // DATA_DIR: zie de toelichting in server/db.js — dezelfde permanente
  // opslaglocatie (bv. een Railway Volume) gebruiken voor de geplande exports.
  const exportsDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const dateStr = getDutchDateString(); // YYYY-MM-DD, Nederlandse tijdzone
  const outputPath = path.join(exportsDir, `tegeltjes-${dateStr}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    appendPrintFilesToArchive(archive, targets)
      .then(() => archive.finalize())
      .catch(reject);
  });

  console.log(`[auto-export] ${targets.length} orders verwerkt, opgeslagen als exports/tegeltjes-${dateStr}.zip`);
}

// --- Cron: elke 5 minuten synchroniseren met Shopify ---
cron.schedule('*/5 * * * *', async () => {
  try {
    console.log('[sync] start automatische sync...');
    const result = await syncOrders();
    console.log(`[sync] klaar: ${result.totalNew} nieuwe orders, ${result.totalSeen} verwerkt`);
  } catch (e) {
    console.error('[sync] fout tijdens automatische sync:', e.message);
  }
});

// --- Cron: elke nacht om 03:00 (Nederlandse tijd) orders ouder dan 1 maand
// opruimen, om de database schoon te houden ---
const ORDER_RETENTION_DAYS = parseInt(process.env.ORDER_RETENTION_DAYS || '30', 10);
cron.schedule('0 3 * * *', () => {
  try {
    const deleted = deleteOldOrders(ORDER_RETENTION_DAYS);
    if (deleted > 0) console.log(`[opruimen] ${deleted} orders ouder dan ${ORDER_RETENTION_DAYS} dagen verwijderd.`);
  } catch (e) {
    console.error('[opruimen] fout tijdens opruimen van oude orders:', e.message);
  }
}, { timezone: 'Europe/Amsterdam' });

// --- Automatische export om 12:00 is UITGEZET op verzoek — dit gebeurt nu
// alleen nog handmatig, via de knop "Drukwerkbestanden (PDF)" in het
// dashboard, of via het endpoint hieronder (/api/print-files/run-scheduled-
// export). De functie runScheduledPrintFilesExport() zelf staat nog gewoon
// klaar, alleen de automatische cron-planning ernaartoe is verwijderd.

// --- Handmatig endpoint om dezelfde verzameling (op basis van status "wacht
// op drukwerkbestand") alsnog handmatig te triggeren ---
app.post('/api/print-files/run-scheduled-export', requireAdmin, async (req, res) => {
  try {
    await runScheduledPrintFilesExport();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Trustpilot-review-mail: X dagen nadat een order op "verzonden" is gezet,
// automatisch een mailtje sturen om een review te vragen. Staat de order
// inmiddels op "geannuleerd" of "onjuiste gegevens", dan wordt 'm overgeslagen.
// Elke order krijgt deze mail maar 1x (zie review_email_sent_at in db.js). ---
const REVIEW_EMAIL_DELAY_DAYS = parseInt(process.env.REVIEW_EMAIL_DELAY_DAYS || '5', 10);

async function runReviewEmailCheck() {
  const orders = getOrdersReadyForReviewEmail(REVIEW_EMAIL_DELAY_DAYS);
  if (orders.length === 0) {
    console.log('[review-mail] geen orders klaar voor een review-mail, niets te doen.');
    return;
  }
  let succeeded = 0;
  for (const order of orders) {
    try {
      await sendReviewEmail(order);
      markReviewEmailSent(order.id);
      succeeded++;
    } catch (e) {
      console.error(`[review-mail] kon geen mail versturen voor order ${order.order_number || order.id}:`, e.message);
    }
  }
  console.log(`[review-mail] ${succeeded}/${orders.length} review-mails verstuurd.`);
}

// Elke dag om 10:00 (Nederlandse tijd) controleren
cron.schedule('0 10 * * *', async () => {
  try {
    console.log('[review-mail] start controle op orders voor review-mail...');
    await runReviewEmailCheck();
  } catch (e) {
    console.error('[review-mail] fout tijdens automatische controle:', e.message);
  }
}, { timezone: 'Europe/Amsterdam' });

// --- Handmatig endpoint om de review-mail-controle direct te testen/triggeren ---
app.post('/api/reviews/run-scheduled-check', requireAdmin, async (req, res) => {
  try {
    await runReviewEmailCheck();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Handmatig endpoint om het opruimen direct te testen/triggeren ---
app.post('/api/cleanup-old-orders', (req, res) => {
  try {
    const deleted = deleteOldOrders(ORDER_RETENTION_DAYS);
    res.json({ deleted, retentionDays: ORDER_RETENTION_DAYS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Order dashboard draait op http://localhost:${PORT}`);
  // Eerste sync direct bij opstarten
  syncOrders()
    .then(r => console.log(`[sync] initiele sync: ${r.totalNew} nieuwe orders, ${r.totalSeen} verwerkt`))
    .catch(e => console.error('[sync] initiele sync mislukt:', e.message));

  // Ook meteen bij opstarten een keer opruimen (niet alleen 's nachts wachten)
  try {
    const deleted = deleteOldOrders(ORDER_RETENTION_DAYS);
    if (deleted > 0) console.log(`[opruimen] ${deleted} orders ouder dan ${ORDER_RETENTION_DAYS} dagen verwijderd.`);
  } catch (e) {
    console.error('[opruimen] fout tijdens opruimen van oude orders:', e.message);
  }
});
