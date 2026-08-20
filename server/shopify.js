const axios = require('axios');
const { upsertOrder, getMeta, setMeta } = require('./db');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const INITIAL_SYNC_DAYS = parseInt(process.env.INITIAL_SYNC_DAYS || '30', 10);

const SPOTIFY_REGEX = /(https?:\/\/open\.spotify\.com\/[^\s"'<>]+|spotify:[a-zA-Z]+:[a-zA-Z0-9]+)/gi;
// Herkent geuploade afbeeldingen (bv. via een "upload je foto" custom field app) aan de bestandsextensie
const IMAGE_REGEX = /(https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?[^\s"'<>]*)?)/gi;
// De autopictura design-link heeft geen bestandsextensie (bv. .../design-link/<uuid>),
// dus die wordt los herkend op basis van het domein + pad, niet op extensie.
const AUTOPICTURA_REGEX = /(https?:\/\/[^\s"'<>]*autopictura[^\s"'<>]*)/gi;
// Bestanden die de klant zelf rechtstreeks via Shopify uploadt (bv. een "upload je ontwerp"
// veld) landen op Shopify's eigen CDN, soms zonder duidelijke/herkenbare extensie in de URL.
const SHOPIFY_CDN_UPLOAD_REGEX = /(https?:\/\/cdn\.shopify\.com\/s\/files\/[^\s"'<>]+)/gi;

function client() {
  if (!STORE || !TOKEN) {
    throw new Error('SHOPIFY_STORE en SHOPIFY_ACCESS_TOKEN moeten ingesteld zijn in .env');
  }
  return axios.create({
    baseURL: `https://${STORE}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    }
  });
}

// Zoekt Spotify links in line item properties, notes en note_attributes van een order
function extractSpotifyLinks(order) {
  const found = new Set();
  const haystacks = [];

  if (order.note) haystacks.push(order.note);
  (order.note_attributes || []).forEach(a => haystacks.push(`${a.name}: ${a.value}`));
  (order.line_items || []).forEach(li => {
    (li.properties || []).forEach(p => haystacks.push(`${p.name}: ${p.value}`));
  });

  haystacks.forEach(text => {
    const matches = String(text).match(SPOTIFY_REGEX);
    if (matches) matches.forEach(m => found.add(m));
  });

  return Array.from(found);
}

// Zoekt geuploade foto's/bestanden (gepersonaliseerde producten) in line item properties.
// Dit omvat gewone foto-uploads (herkend aan bestandsextensie), autopictura
// design-links (herkend aan het domein, want die hebben geen extensie), en
// bestanden die de klant rechtstreeks via Shopify's eigen CDN heeft geupload.
//
// Belangrijk: er wordt alleen gededupliceerd BINNEN 1 productregel (om dubbele
// regex-matches van dezelfde link samen te voegen), niet tussen verschillende
// regels. Bestelt een klant bv. 2x exact dezelfde tegel als 2 aparte
// productregels, dan komt die link dus 2x in de lijst — anders zou er maar 1
// drukwerkbestand/preview van gemaakt worden terwijl er 2 nodig zijn. Ook het
// bestelde aantal (quantity) van een regel wordt meegeteld.
function extractPhotoLinks(order) {
  const found = [];

  (order.line_items || []).forEach(li => {
    const lineItemLinks = new Set(); // dedupliceren binnen deze ene regel

    (li.properties || []).forEach(p => {
      const text = `${p.name}: ${p.value}`;

      const imageMatches = String(text).match(IMAGE_REGEX);
      if (imageMatches) imageMatches.forEach(m => lineItemLinks.add(m));

      const autopicturaMatches = String(text).match(AUTOPICTURA_REGEX);
      if (autopicturaMatches) autopicturaMatches.forEach(m => lineItemLinks.add(m));

      const cdnMatches = String(text).match(SHOPIFY_CDN_UPLOAD_REGEX);
      if (cdnMatches) cdnMatches.forEach(m => lineItemLinks.add(m));
    });

    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    lineItemLinks.forEach(link => {
      for (let i = 0; i < qty; i++) {
        found.push(link);
      }
    });
  });

  return found;
}

// Herkent het product "Gepersonaliseerde foto tegel" (of vergelijkbare
// schrijfwijzen) — dit product heeft GEEN autopictura-ontwerplink, alleen een
// kale foto-upload onder de eigenschap "Kies jouw foto". Pas deze regex aan
// als de exacte producttitel in Shopify net anders geschreven blijkt te zijn.
function isFotoTegelLineItem(li) {
  return /gepersonaliseerde?\s*foto\s*tegel(tje)?s?/i.test(li.title || '');
}

// Haalt voor elke "Gepersonaliseerde foto tegel"-regel de geuploade foto op
// (property "Kies jouw foto", of vergelijkbaar) — met aantal (quantity)
// meegeteld, net als bij de andere producten: 2x besteld = 2 losse bestanden.
function extractFotoTegelPhotoUrls(lineItems) {
  const urls = [];
  (lineItems || []).forEach(li => {
    if (!isFotoTegelLineItem(li)) return;
    const photoProp = (li.properties || []).find(p => /kies\s*jouw\s*foto/i.test(p.name || ''));
    if (!photoProp || !photoProp.value) return;
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) urls.push(photoProp.value);
  });
  return urls;
}

// Herkent orders die via de Posterly-app binnenkomen: die hebben een
// eigenschap "_print_file" met een link naar cdn.posterlyapp.io. Deze foto's
// bevatten nog canvas/rand eromheen en moeten daarom eerst uit het midden
// bijgeknipt worden (zie cropPosterlyCanvas in printfile.js) — in
// tegenstelling tot autopictura/foto-tegel-links, die al de juiste afmeting
// hebben. Werkt op basis van de eigenschap zelf, niet de producttitel — dus
// ongeacht op welk product Posterly wordt gebruikt.
function extractPosterlyPhotoUrls(lineItems) {
  const urls = [];
  (lineItems || []).forEach(li => {
    const printFileProp = (li.properties || []).find(p =>
      /print_file/i.test(p.name || '') && /posterlyapp\.io/i.test(p.value || '')
    );
    if (!printFileProp) return;
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) urls.push(printFileProp.value);
  });
  return urls;
}

// Verzamelt alle "tegel-achtige" producten (autopictura-tegeltjes,
// "Gepersonaliseerde foto tegel", Posterly) uit een order, met het formaat
// (10x10/13x13) PER REGEL apart bepaald. Belangrijk bij orders met meerdere
// tegels van een verschillend formaat: zonder dit zou 1 regel met "13x13"
// erin per ongeluk ALLE tegels in de hele order 13x13 maken, ook een andere
// regel die eigenlijk gewoon 10x10 moest zijn.
function extractTileItemsFromOrder(lineItems) {
  const items = [];
  (lineItems || []).forEach(li => {
    const props = li.properties || [];
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    const textBlob = [li.title, li.variant_title, ...props.map(p => `${p.name} ${p.value}`)].join(' ');
    const is13x13 = /13\s*x\s*13/i.test(textBlob);

    // Autopictura-link binnen DEZE regel
    let autopicturaLink = null;
    for (const p of props) {
      const m = String(p.value || '').match(AUTOPICTURA_REGEX);
      if (m) { autopicturaLink = m[0]; break; }
    }
    if (autopicturaLink) {
      for (let i = 0; i < qty; i++) items.push({ link: autopicturaLink, is13x13, isPosterly: false });
      return;
    }

    // "Gepersonaliseerde foto tegel"
    if (isFotoTegelLineItem(li)) {
      const photoProp = props.find(p => /kies\s*jouw\s*foto/i.test(p.name || ''));
      if (photoProp && photoProp.value) {
        for (let i = 0; i < qty; i++) items.push({ link: photoProp.value, is13x13, isPosterly: false });
      }
      return;
    }

    // Posterly
    const printFileProp = props.find(p => /print_file/i.test(p.name || '') && /posterlyapp\.io/i.test(p.value || ''));
    if (printFileProp) {
      for (let i = 0; i < qty; i++) items.push({ link: printFileProp.value, is13x13, isPosterly: true });
    }
  });
  return items;
}

// Herkent of een productregel een Auto-frame is — Nederlands ("Auto-frame")
// en Duits ("Auto-rahmen"), met of zonder streepje, of met een spatie in
// plaats van een streepje (Shopify-titels zijn hierin niet altijd
// consistent, bv. "Auto frame" i.p.v. "Auto-frame").
function isAutoFrameLineItem(li) {
  return /auto[\s-]?frame|auto[\s-]?rahmen/i.test(li.title || '');
}

// Herkent de "klein" / "dik" variant, net als bij het muziekframe.
function getAutoFrameVariant(li) {
  const text = [li.title, li.variant_title].filter(Boolean).join(' ');
  if (/\bdik\b/i.test(text)) return 'dik';
  if (/\bklein\b/i.test(text)) return 'klein';
  return null;
}

// Haalt de door de klant ingevulde velden uit de properties van 1 Auto-frame-
// productregel. Net als bij het muziekframe zijn dit BESTE-INSCHATTING-regexen
// (nog geen echte Shopify-voorbeeldgegevens gezien voor dit product) — geef
// door als de herkenning een keer niet klopt, dan stel ik 'm bij.
function extractAutoFrameData(li) {
  const props = li.properties || [];
  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  return {
    style: getProp(/stijl van jouw socialframe/i),
    link: getProp(/link naar.*(foto|filmpje)|qr-?code/i),
    fotoFilter: getProp(/foto-?filter/i),
    achtergrondKleur: getProp(/achtergrond\s*kleur/i),
    titel: getProp(/merk.{0,8}type/i),
    motor: getProp(/\bmotor\b/i),
    pk: getProp(/\bpk\b|paardenkracht/i),
    snelheid: getProp(/snelheid/i),
    naam: getProp(/\bnaam\b/i),
    photoUrl: getProp(/upload hier jouw favoriete foto|kies jouw foto/i)
  };
}

// Zoekt in een volledige (raw) Shopify-order naar Auto-frame-productregels,
// en geeft voor elke bestelde stuks (quantity) een los item terug.
function extractAutoFrameItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isAutoFrameLineItem(li)) return;
    const data = extractAutoFrameData(li);
    const variant = getAutoFrameVariant(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, variant, data });
    }
  });
  return items;
}

// Bepaalt de startstatus van een nieuwe order. Bestaat een order UITSLUITEND
// uit producten met "Tegeltje met tekst" in de titel EN heeft de order
// daadwerkelijk geen enkele foto/ontwerp-link (autopictura/upload) — dan
// slaan we "wacht op drukwerkbestand" over en gaat de order direct naar
// "wacht op productie". Zit er een foto/ontwerp-link bij (ongeacht wat er in
// de titel staat, dus ook bij bijvoorbeeld "Tegeltje met tekst en foto" of
// "... personaliseerbaar met eigen foto"), dan geldt altijd gewoon de
// normale standaardstatus — we vertrouwen hier op de daadwerkelijk gevonden
// link, niet op het gokken naar woorden als "foto"/"personaliseerbaar" in de titel.
// `fulfillmentStatus` is Shopify's eigen fulfillment-status ('fulfilled',
// 'partial', of null/undefined) — staat een order daar al als volledig
// verzonden, dan hoeft 'ie hier niet nog eens als "te doen" te verschijnen.
// Vooral relevant bij het met terugwerkende kracht ophalen van oudere orders
// (INITIAL_SYNC_DAYS hoger gezet): zonder deze check zouden allang verzonden
// orders alsnog als "wacht op drukwerkbestand" binnenkomen.
function determineInitialStatus(lineItems, photoLinks, fulfillmentStatus) {
  if (fulfillmentStatus === 'fulfilled') return 'verzonden';
  if (!lineItems || lineItems.length === 0) return 'wacht op drukwerkbestand';
  if (photoLinks && photoLinks.length > 0) return 'wacht op drukwerkbestand';
  const allTextTiles = lineItems.every(li => /tegeltje met tekst/i.test(li.title || ''));
  return allTextTiles ? 'wacht op productie' : 'wacht op drukwerkbestand';
}

function mapOrder(order) {
  const addr = order.shipping_address || order.customer?.default_address || {};
  // addr.name bewust weggelaten: customer_name wordt al apart getoond (bv. op de
  // pakbon), dus die zou anders dubbel op het bonnetje/in de popup verschijnen.
  // Postcode + plaats samen op 1 regel (gebruikelijke NL-adresnotatie), i.p.v.
  // los van elkaar, anders komen ze bij het weergeven apart op de regel te staan.
  const postcodeCity = [addr.zip, addr.city].filter(Boolean).join(' ');
  const shippingAddress = [
    addr.address1, addr.address2, postcodeCity, addr.province, addr.country
  ].filter(Boolean).join(', ');

  const lineItems = (order.line_items || []).map(li => ({
    title: li.title,
    variant_title: li.variant_title,
    quantity: li.quantity,
    price: li.price,
    sku: li.sku,
    properties: li.properties || []
  }));

  const photoLinks = extractPhotoLinks(order);

  // Realistisch verzend-tijdstip proberen te achterhalen uit Shopify's eigen
  // fulfillment-data — belangrijk voor de Trustpilot-review-mail (die telt 5
  // dagen vanaf DIT moment) en ook gewoon inhoudelijk correcter dan het
  // moment van synchroniseren te gebruiken.
  const fulfillmentCreatedAt = order.fulfillments && order.fulfillments[0]
    ? order.fulfillments[0].created_at
    : null;
  const verzondenAt = fulfillmentCreatedAt || order.closed_at || null;

  return {
    shopify_order_id: String(order.id),
    order_number: String(order.order_number || order.name || ''),
    customer_name: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : (addr.name || ''),
    customer_email: order.email || order.customer?.email || '',
    customer_phone: order.phone || order.customer?.phone || addr.phone || '',
    shipping_address: shippingAddress,
    shipping_country_code: addr.country_code || '',
    line_items_json: JSON.stringify(lineItems),
    spotify_links_json: JSON.stringify(extractSpotifyLinks(order)),
    photo_links_json: JSON.stringify(photoLinks),
    raw_json: JSON.stringify(order),
    shopify_created_at: order.created_at,
    initial_status: determineInitialStatus(lineItems, photoLinks, order.fulfillment_status),
    verzonden_at: verzondenAt
  };
}

async function syncOrders() {
  const api = client();
  let sinceId = getMeta('last_since_id');
  let createdAtMin = getMeta('first_sync_done')
    ? null
    : new Date(Date.now() - INITIAL_SYNC_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const url = '/orders.json';
  // Belangrijk: Shopify staat niet toe dat "order" en "since_id" tegelijk worden
  // meegegeven ("order cannot be passed when since_id is present"). Zodra we een
  // since_id hebben (bij een vervolg-sync, of bij paginering binnen deze sync),
  // laten we "order" en "created_at_min" dus helemaal weg.
  // status: 'open' — haalt alleen openstaande orders op, geen afgehandelde/gearchiveerde.
  let params = sinceId
    ? { status: 'open', limit: 250, since_id: sinceId }
    : { status: 'open', limit: 250, order: 'created_at asc', ...(createdAtMin ? { created_at_min: createdAtMin } : {}) };

  let totalNew = 0;
  let totalSeen = 0;
  let lastId = sinceId ? Number(sinceId) : null;

  // Shopify's REST API pagineert via since_id
  while (true) {
    let res;
    try {
      res = await api.get(url, { params });
    } catch (e) {
      const status = e.response?.status;
      const fullUrl = (e.config?.baseURL || '') + (e.config?.url || '');
      const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
      throw new Error(
        `Shopify-verzoek mislukt${status ? ' (status ' + status + ')' : ''} naar ${fullUrl}. ` +
        `Controleer SHOPIFY_STORE (moet zijn: iets.myshopify.com, zonder https:// of trailing slash) ` +
        `en SHOPIFY_ACCESS_TOKEN in je .env.${body ? ' Shopify zei: ' + body : ''}`
      );
    }
    const orders = res.data.orders || [];
    if (orders.length === 0) break;

    for (const order of orders) {
      const mapped = mapOrder(order);
      const result = upsertOrder(mapped);
      if (result.isNew) totalNew++;
      totalSeen++;
      lastId = order.id;
    }

    if (orders.length < params.limit) break;
    // Voor de volgende pagina altijd schoon overschakelen naar pure since_id-paginering
    params = { status: 'open', limit: 250, since_id: lastId };
  }

  if (lastId) setMeta('last_since_id', String(lastId));
  setMeta('first_sync_done', 'true');
  setMeta('last_sync_at', new Date().toISOString());

  return { totalNew, totalSeen, syncedAt: new Date().toISOString() };
}

module.exports = { syncOrders, extractSpotifyLinks, extractPhotoLinks, mapOrder, isFotoTegelLineItem, extractFotoTegelPhotoUrls, extractPosterlyPhotoUrls, extractTileItemsFromOrder, isAutoFrameLineItem, getAutoFrameVariant, extractAutoFrameData, extractAutoFrameItemsFromOrder };
