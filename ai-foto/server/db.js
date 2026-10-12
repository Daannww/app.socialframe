const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });
const db = new Database(path.join(DATA_DIR, 'ai-foto.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  example_file TEXT DEFAULT '',        -- voorbeeldafbeelding in files/
  prompt TEXT NOT NULL,
  negative_prompt TEXT DEFAULT '',
  model TEXT NOT NULL DEFAULT 'fal-ai/flux-pro/kontext',
  extra_json TEXT DEFAULT '{}',        -- extra parameters voor het fal-model
  products TEXT DEFAULT '*',           -- '*' of komma-lijst met product-handles
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  ip TEXT,
  design_id INTEGER NOT NULL,
  profile TEXT NOT NULL,               -- tegel | poster
  orientation TEXT DEFAULT 'landscape',
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error
  error TEXT,
  original_file TEXT,
  preview_file TEXT,
  print_file TEXT,
  print_w INTEGER, print_h INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_client ON jobs(client_id, created_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('designs', 'slug', "TEXT DEFAULT ''");              // korte naam voor de productinstelling (metafield)
addColumn('designs', 'prompt_with_text', "TEXT DEFAULT ''");   // andere prompt als de klant tekst invult ({{tekst}})
addColumn('designs', 'text_required', 'INTEGER DEFAULT 0');   // klant moet tekst invullen
addColumn('designs', 'text_label', "TEXT DEFAULT ''");         // label bij het tekstveld
addColumn('jobs', 'variants_json', "TEXT DEFAULT '[]'");      // alle gemaakte varianten (klant kiest er één)
addColumn('jobs', 'chosen', 'INTEGER');                          // index van de gekozen variant
addColumn('jobs', 'custom_text', "TEXT DEFAULT ''");
addColumn('jobs', 'reuse_count', 'INTEGER DEFAULT 0');
addColumn('jobs', 'last_reused_at', 'TEXT');

const DEFAULT_SETTINGS = {
  variants: '2',                // aantal varianten per poging; de klant kiest er één (1 = geen keuze, max 3)
  text_max: '40',               // maximaal aantal tekens dat een klant mag invullen
  max_attempts: '4',            // pogingen per klant (browser/client_id) per 24 uur
  max_attempts_ip: '12',        // pogingen per IP-adres per 24 uur (hoger, want gezinnen/kantoren delen een IP)
  upscale_model: 'fal-ai/clarity-upscaler',
  tegel_px: '1600',             // 13x13 cm @ ~300 dpi = 1535 px
  poster_long_px: '2800',       // 70x50 cm @ ~100 dpi
  retention_days: '180',
};
const getSetting = (k) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return r ? r.value : DEFAULT_SETTINGS[k];
};
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const allSettings = () => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, getSetting(k)]));

module.exports = { db, DATA_DIR, getSetting, setSetting, allSettings, DEFAULT_SETTINGS };
