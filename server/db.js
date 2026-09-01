const Database = require('better-sqlite3');
const path = require('path');
const { DEFAULT_INVENTORY_ITEMS, computeDeductionsForOrder } = require('./inventory');

// DATA_DIR: waar de database (en later ook de exports/ map) staan. Standaard
// gewoon de projectmap zelf (lokaal draaien), maar op Railway (of een andere
// host met een NIET-permanent bestandssysteem) zet je dit op het pad van een
// permanente "Volume" (bv. DATA_DIR=/data) — anders ben je bij elke nieuwe
// deploy alle order-data kwijt, want dan wordt de projectmap gewoon opnieuw
// vanuit de code opgebouwd.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');

const db = new Database(path.join(dataDir, 'orders.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id TEXT UNIQUE NOT NULL,
  order_number TEXT,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  shipping_address TEXT,
  shipping_country_code TEXT,
  line_items_json TEXT,
  spotify_links_json TEXT,
  photo_links_json TEXT,
  status TEXT NOT NULL DEFAULT 'wacht op drukwerkbestand',
  raw_json TEXT,
  shopify_created_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 50,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// Standaard voorraadartikelen aanmaken als de tabel nog leeg is (bv. bij de
// allereerste keer opstarten na deze update).
const inventoryCount = db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c;
if (inventoryCount === 0) {
  const insertItem = db.prepare('INSERT INTO inventory_items (name, stock) VALUES (?, 0)');
  DEFAULT_INVENTORY_ITEMS.forEach(name => insertItem.run(name));
}

// Migratie: als orders.db al bestond van vóór photo_links_json, kolom toevoegen
try {
  db.exec('ALTER TABLE orders ADD COLUMN photo_links_json TEXT');
} catch (e) {
  // kolom bestaat al, negeren
}

// Migratie: als orders.db al bestond van vóór shipping_country_code, kolom toevoegen
try {
  db.exec('ALTER TABLE orders ADD COLUMN shipping_country_code TEXT');
} catch (e) {
  // kolom bestaat al, negeren
}

// Migratie: kolommen voor de Trustpilot-review-mail (wanneer de order op
// "verzonden" gezet is, en of de review-mail al verstuurd is)
try {
  db.exec('ALTER TABLE orders ADD COLUMN verzonden_at TEXT');
} catch (e) {
  // kolom bestaat al, negeren
}
try {
  db.exec('ALTER TABLE orders ADD COLUMN review_email_sent_at TEXT');
} catch (e) {
  // kolom bestaat al, negeren
}

// Migratie: handmatige formaat-override voor tegeltjes ('10x10' / '13x13' /
// NULL = automatisch op basis van de besteltekst, zoals nu al gebeurt)
try {
  db.exec("ALTER TABLE orders ADD COLUMN size_override TEXT");
} catch (e) {
  // kolom bestaat al, negeren
}

// Migratie: vrij notitieveld per order (bv. bijzonderheden die staff zelf
// willen bijhouden) — verschijnt ook onderaan op de pakbon als 'm is ingevuld.
try {
  db.exec("ALTER TABLE orders ADD COLUMN note TEXT");
} catch (e) {
  // kolom bestaat al, negeren
}

// Migratie: standaard-lagevoorraaddrempel opgehoogd van 20 naar 50 stuks —
// bestaande artikelen die nog op de OUDE standaardwaarde (20) staan, worden
// hier EENMALIG bijgewerkt (via een vlag in sync_meta, zodat dit maar 1x
// gebeurt — anders zou een later bewust wéér op 20 gezette drempel bij elke
// serverherstart steeds opnieuw teruggezet worden naar 50).
if (!getMeta('migratie_lagevoorraad_50_uitgevoerd')) {
  db.exec('UPDATE inventory_items SET low_stock_threshold = 50 WHERE low_stock_threshold = 20');
  setMeta('migratie_lagevoorraad_50_uitgevoerd', 'true');
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getInventory() {
  return db.prepare('SELECT * FROM inventory_items ORDER BY id ASC').all();
}

function setInventoryStock(id, stock) {
  db.prepare(`UPDATE inventory_items SET stock = ?, updated_at = datetime('now') WHERE id = ?`).run(stock, id);
  return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
}

// Trekt qty af van de voorraad van het genoemde artikel (op naam). Doet niets
// als er geen voorraadartikel met die naam bestaat.
function deductInventory(name, qty) {
  const row = db.prepare('SELECT * FROM inventory_items WHERE name = ?').get(name);
  if (!row) return null;
  const newStock = row.stock - qty;
  db.prepare(`UPDATE inventory_items SET stock = ?, updated_at = datetime('now') WHERE id = ?`).run(newStock, row.id);
  return { ...row, stock: newStock };
}

// Voegt een nieuw voorraadartikel toe. Geeft null terug als de naam al bestaat.
function addInventoryItem(name, stock) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return null;
  const existing = db.prepare('SELECT id FROM inventory_items WHERE name = ?').get(trimmedName);
  if (existing) return null;
  const result = db.prepare('INSERT INTO inventory_items (name, stock) VALUES (?, ?)').run(trimmedName, stock || 0);
  return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(result.lastInsertRowid);
}

function deleteInventoryItem(id) {
  db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
}

function upsertOrder(order) {
  const existing = db.prepare('SELECT id, status FROM orders WHERE shopify_order_id = ?').get(order.shopify_order_id);

  if (existing) {
    // Bestaande order: status NIET aanpassen, alleen orderdata verversen
    db.prepare(`
      UPDATE orders SET
        order_number = ?,
        customer_name = ?,
        customer_email = ?,
        customer_phone = ?,
        shipping_address = ?,
        shipping_country_code = ?,
        line_items_json = ?,
        spotify_links_json = ?,
        photo_links_json = ?,
        raw_json = ?,
        updated_at = datetime('now')
      WHERE shopify_order_id = ?
    `).run(
      order.order_number, order.customer_name, order.customer_email, order.customer_phone,
      order.shipping_address, order.shipping_country_code, order.line_items_json, order.spotify_links_json,
      order.photo_links_json, order.raw_json,
      order.shopify_order_id
    );
    return { isNew: false };
  } else {
    // Nieuwe order: normaal "wacht op drukwerkbestand", tenzij de order
    // uitsluitend uit "Tegeltje met tekst"-producten bestaat (zie
    // determineInitialStatus in shopify.js) — dan direct "wacht op productie".
    // Staat de order in Shopify zelf al als volledig fulfilled, dan komt 'ie
    // direct op "verzonden" binnen, mét het bijbehorende verzonden_at (nodig
    // voor de Trustpilot-review-mail-timing).
    const initialStatus = order.initial_status || 'wacht op drukwerkbestand';
    const verzondenAt = initialStatus === 'verzonden' ? (order.verzonden_at || new Date().toISOString()) : null;
    db.prepare(`
      INSERT INTO orders
      (shopify_order_id, order_number, customer_name, customer_email, customer_phone,
       shipping_address, shipping_country_code, line_items_json, spotify_links_json, photo_links_json, raw_json, shopify_created_at, status, verzonden_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      order.shopify_order_id, order.order_number, order.customer_name, order.customer_email,
      order.customer_phone, order.shipping_address, order.shipping_country_code, order.line_items_json,
      order.spotify_links_json, order.photo_links_json, order.raw_json, order.shopify_created_at,
      initialStatus, verzondenAt
    );

    // Voorraad automatisch bijwerken voor deze nieuwe order (alleen bij
    // NIEUWE orders — niet opnieuw aftrekken als een order later opnieuw
    // gesynchroniseerd wordt).
    try {
      const lineItems = JSON.parse(order.line_items_json || '[]');
      const deductions = computeDeductionsForOrder({ line_items: lineItems }, getInventory());
      Object.entries(deductions).forEach(([name, qty]) => {
        deductInventory(name, qty);
      });
    } catch (e) {
      console.error('[voorraad] kon voorraad niet bijwerken voor nieuwe order:', e.message);
    }

    return { isNew: true };
  }
}

function listOrders(statusFilter) {
  if (statusFilter) {
    return db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY shopify_created_at DESC').all(statusFilter);
  }
  return db.prepare('SELECT * FROM orders ORDER BY shopify_created_at DESC').all();
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function updateStatus(id, status) {
  // Alleen de allereerste keer dat een order "verzonden" wordt, verzonden_at
  // vastleggen (niet opnieuw overschrijven als iemand de status per ongeluk
  // heen-en-weer wijzigt) — dit is het ankerpunt voor de Trustpilot-review-mail
  // (5 dagen na deze datum, zie server/reviewEmail.js).
  const current = db.prepare('SELECT status, verzonden_at FROM orders WHERE id = ?').get(id);
  const justShipped = status === 'verzonden' && current && current.status !== 'verzonden' && !current.verzonden_at;

  if (justShipped) {
    db.prepare(`UPDATE orders SET status = ?, verzonden_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(status, id);
  } else {
    db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  }
  return getOrder(id);
}

function updateStatusBulk(ids, status) {
  const selectStmt = db.prepare('SELECT status, verzonden_at FROM orders WHERE id = ?');
  const withTimestamp = db.prepare(`UPDATE orders SET status = ?, verzonden_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`);
  const withoutTimestamp = db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`);
  const run = db.transaction((idList) => {
    idList.forEach(id => {
      const current = selectStmt.get(id);
      const justShipped = status === 'verzonden' && current && current.status !== 'verzonden' && !current.verzonden_at;
      if (justShipped) {
        withTimestamp.run(status, id);
      } else {
        withoutTimestamp.run(status, id);
      }
    });
  });
  run(ids);
  return ids.length;
}

// Orders ouder dan het opgegeven aantal dagen verwijderen (op basis van de
// Shopify aanmaakdatum van de order), zodat de lokale database niet
// onbeperkt blijft groeien. Wordt periodiek automatisch aangeroepen.
function deleteOldOrders(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM orders WHERE shopify_created_at IS NOT NULL AND shopify_created_at < ?').run(cutoff);
  return result.changes;
}

// Orders die klaar zijn voor de Trustpilot-review-mail: status nog steeds
// "verzonden" (dus niet nadien alsnog geannuleerd/onjuiste-gegevens),
// verzonden_at minstens `delayDays` geleden, review-mail nog niet verstuurd,
// en er is een e-mailadres om naartoe te sturen.
function getOrdersReadyForReviewEmail(delayDays) {
  const cutoff = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM orders
    WHERE status = 'verzonden'
      AND verzonden_at IS NOT NULL
      AND verzonden_at <= ?
      AND review_email_sent_at IS NULL
      AND customer_email IS NOT NULL
      AND customer_email != ''
  `).all(cutoff);
}

function markReviewEmailSent(id) {
  db.prepare(`UPDATE orders SET review_email_sent_at = datetime('now') WHERE id = ?`).run(id);
}

// Handmatige formaat-override voor een order instellen. `override` is
// '10x10', '13x13', of null (= terug naar automatisch, op basis van de
// besteltekst). Wordt gebruikt door zowel het drukwerkbestand als de pakbon.
function setSizeOverride(id, override) {
  const valid = override === '10x10' || override === '13x13' ? override : null;
  db.prepare('UPDATE orders SET size_override = ? WHERE id = ?').run(valid, id);
  return getOrder(id);
}

function setNote(id, note) {
  const trimmed = (note || '').trim();
  db.prepare('UPDATE orders SET note = ? WHERE id = ?').run(trimmed || null, id);
  return getOrder(id);
}

// Alle orders met hun opgeslagen raw_json ophalen — voor het lokaal herberekenen
// van spotify_links/photo_links zonder opnieuw bij Shopify te hoeven ophalen.
function getAllOrdersRaw() {
  return db.prepare('SELECT id, raw_json FROM orders').all();
}

function updateLinks(id, spotifyLinksJson, photoLinksJson) {
  db.prepare(`
    UPDATE orders SET spotify_links_json = ?, photo_links_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(spotifyLinksJson, photoLinksJson, id);
}

// Alle afgeleide velden van een order in 1x bijwerken (adres, klantgegevens,
// items, links) op basis van een verse mapOrder()-mapping — zonder de status
// aan te raken. Gebruikt door "Links herberekenen" zodat ook bestaande orders
// verbeteringen in de mapping (bv. het adres) met terugwerkende kracht krijgen.
function updateDerivedFields(id, mapped) {
  db.prepare(`
    UPDATE orders SET
      order_number = ?,
      customer_name = ?,
      customer_email = ?,
      customer_phone = ?,
      shipping_address = ?,
      shipping_country_code = ?,
      line_items_json = ?,
      spotify_links_json = ?,
      photo_links_json = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    mapped.order_number, mapped.customer_name, mapped.customer_email, mapped.customer_phone,
    mapped.shipping_address, mapped.shipping_country_code, mapped.line_items_json, mapped.spotify_links_json,
    mapped.photo_links_json, id
  );
}

module.exports = {
  db, getMeta, setMeta, upsertOrder, listOrders, getOrder, updateStatus, updateStatusBulk,
  getAllOrdersRaw, updateLinks, updateDerivedFields, deleteOldOrders,
  getInventory, setInventoryStock, deductInventory, addInventoryItem, deleteInventoryItem,
  getOrdersReadyForReviewEmail, markReviewEmailSent, setSizeOverride, setNote
};
