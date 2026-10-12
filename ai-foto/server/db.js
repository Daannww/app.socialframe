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

const DEFAULT_SETTINGS = {
  max_attempts: '4',            // pogingen per klant (client_id) per 24 uur
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
