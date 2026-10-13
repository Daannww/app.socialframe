// Houdt de Shopify-voorraad van gedeelde SKU's gelijk aan het eigen voorraadsysteem (tabblad "Voorraad").
// Eén getal per artikel; alle varianten (op alle producten) met die SKU krijgen datzelfde getal. Zo gaat een lijst of
// metalen houder die via het ene product is besteld ook af bij de andere producten.
// Staat standaard UIT: zet de variabele SHOPIFY_STOCK_SYNC=1 op de server om het aan te zetten.
const axios = require('axios');

// Per artikel: de SKU én dezelfde herkenning op variant-tekst als in het voorraadsysteem (lijst/metalen houder + formaat).
// Standaard telt een variant mee als de SKU klopt. Met SHOPIFY_STOCK_MATCH=tekst (of ?tekst=1 bij de handmatige knop) telt ook
// een variant mee waarvan de titel past bij de regel én waarvan het product een tegeltje is. LET OP: de tekstherkenning
// pakt ook andere SKU's (bv. SFTMH van de tekst-tegeltjes) — gebruik eerst ?dry=1 om te zien wat er zou veranderen.
const SKU_MAP = [
  { sku: 'SFTL10', item: 'Lijst 10x10', test: t => /lijst/i.test(t) && /10\s*x\s*10/i.test(t) },
  { sku: 'SFTL13', item: 'Lijst 13x13cm', test: t => /lijst/i.test(t) && /13\s*x\s*13/i.test(t) },
  { sku: 'SFTMHD', item: 'Metalen houder', test: t => /metalen[\s-]?houder/i.test(t) },
  { sku: 'SFCD', item: 'Luxe cadeauverpakking', test: t => /luxe\s*cadeau-?verpakking/i.test(t), create: true }
];

function enabled() { return process.env.SHOPIFY_STOCK_SYNC === '1'; }

function gql() {
  const store = process.env.SHOPIFY_STORE, token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) throw new Error('SHOPIFY_STORE / SHOPIFY_ACCESS_TOKEN ontbreken');
  const version = process.env.SHOPIFY_API_VERSION || '2024-10';
  const http = axios.create({ baseURL: `https://${store}/admin/api/${version}`, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 30000 });
  return async (query, variables) => {
    const r = await http.post('/graphql.json', { query, variables });
    if (r.data.errors) throw new Error(r.data.errors.map(e => e.message).join('; '));
    return r.data.data;
  };
}

async function locationId(q) {
  if (process.env.SHOPIFY_LOCATION_ID) return process.env.SHOPIFY_LOCATION_ID.startsWith('gid://') ? process.env.SHOPIFY_LOCATION_ID : `gid://shopify/Location/${process.env.SHOPIFY_LOCATION_ID}`;
  const d = await q('{ locations(first:5){ nodes{ id isActive } } }');
  const l = d.locations.nodes.find(x => x.isActive) || d.locations.nodes[0];
  if (!l) throw new Error('Geen Shopify-locatie gevonden');
  return l.id;
}

async function allVariants(q, loc) {
  const out = []; let after = null;
  for (let page = 0; page < 40; page++) {
    const d = await q(`query($a:String,$l:ID!){ productVariants(first:200, after:$a){ pageInfo{ hasNextPage endCursor } nodes{ title sku product{ title } inventoryItem{ id tracked inventoryLevel(locationId:$l){ quantities(names:["available"]){ quantity } } } } } }`, { a: after, l: loc });
    out.push(...d.productVariants.nodes);
    if (!d.productVariants.pageInfo.hasNextPage) break;
    after = d.productVariants.pageInfo.endCursor;
  }
  return out;
}

// dry=true: alleen laten zien wat er zou veranderen.
async function pushStockToShopify(getInventory, opts = {}) {
  const { dry = false, force = false } = opts;
  if (!enabled() && !force) return { skipped: true, reason: 'SHOPIFY_STOCK_SYNC staat niet aan' };
  const q = gql(), loc = await locationId(q), inv = getInventory();
  const textMatch = process.env.SHOPIFY_STOCK_MATCH === 'tekst' || opts.tekst === true;
  const variants = await allVariants(q, loc);
  const result = [];
  for (const m of SKU_MAP) {
    let row = inv.find(i => i.name === m.item);
    if (!row && m.create) {
      // Nog niet in het voorraadsysteem: begin met de huidige Shopify-voorraad (nooit met 0, anders zou 'ie uitverkocht raken).
      const v = variants.find(x => x.sku === m.sku && x.inventoryItem && x.inventoryItem.tracked && x.inventoryItem.inventoryLevel && x.inventoryItem.inventoryLevel.quantities[0]);
      if (!v) { result.push({ artikel: m.item, error: `geen bijgehouden Shopify-variant met SKU ${m.sku} gevonden` }); continue; }
      const start = Math.max(0, v.inventoryItem.inventoryLevel.quantities[0].quantity);
      if (dry || !opts.addItem) { result.push({ artikel: m.item, nieuw: `wordt aangemaakt met voorraad ${start}` }); continue; }
      row = opts.addItem(m.item, start) || (getInventory().find(i => i.name === m.item));
      if (!row) { result.push({ artikel: m.item, error: 'aanmaken mislukt' }); continue; }
    }
    if (!row) { result.push({ item: m.item, error: 'voorraadartikel bestaat niet' }); continue; }
    const target = Math.max(0, parseInt(row.stock, 10) || 0);
    const seen = new Set(), changes = [], wijz = [];
    for (const v of variants) {
      const bySku = v.sku === m.sku, byText = textMatch && m.test(v.title || '') && /tegel/i.test((v.product && v.product.title) || '');
      if (!bySku && !byText) continue;
      const it = v.inventoryItem; if (!it || seen.has(it.id)) continue; seen.add(it.id);
      if (!it.tracked) continue;
      const cur = it.inventoryLevel && it.inventoryLevel.quantities[0] ? it.inventoryLevel.quantities[0].quantity : null;
      if (cur === null || cur === target) continue;
      changes.push({ inventoryItemId: it.id, locationId: loc, delta: target - cur });
      wijz.push({ product: v.product && v.product.title, variant: v.title, van: cur, naar: target });
    }
    result.push({ artikel: m.item, doel: target, gevonden: seen.size, aanpassen: wijz.length, wijzigingen: wijz });
    for (let i = 0; !dry && i < changes.length; i += 50) {
      const r = await q(`mutation($i:InventoryAdjustQuantitiesInput!){ inventoryAdjustQuantities(input:$i){ userErrors{ message } } }`,
        { i: { reason: 'correction', name: 'available', changes: changes.slice(i, i + 50) } });
      const errs = r.inventoryAdjustQuantities.userErrors;
      if (errs && errs.length) throw new Error(errs.map(e => e.message).join('; '));
    }
  }
  return { ok: true, dry, result };
}

// Debounce: meerdere triggers vlak na elkaar worden één push.
let timer = null;
function schedulePush(getInventory, addItem) {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    pushStockToShopify(getInventory, { addItem }).then(r => console.log('[voorraad-sync] klaar', JSON.stringify(r.result || r)), e => console.error('[voorraad-sync] fout:', e.message));
  }, 3000);
}

module.exports = { pushStockToShopify, schedulePush, SKU_MAP, enabled };
