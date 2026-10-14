// Zet de meegeleverde standaardroutes (seed-routes/*.gpx) in de database, als ze er nog niet in staan (op naam).
// Wijzigingen in de admin (hernoemen, verbergen, teksten) blijven bestaan; verwijderde routes komen niet terug zolang de naam in 'seed_done' staat.
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('./db');
const routesLib = require('./routes');

const DIR = path.join(__dirname, '..', 'seed-routes');
const LIST = [
  ['enschede_marathon', 'Enschede Marathon', 'Marathon', 'Enschede', 'Netherlands'],
  ['munich_marathon', 'Munich Marathon', 'Marathon', 'Munich', 'Germany'],
  ['munich_half_marathon', 'Munich Half Marathon', 'Half Marathon', 'Munich', 'Germany'],
  ['munich_10km', 'Munich 10 KM', '10 KM', 'Munich', 'Germany'],
  ['oslo_marathon', 'Oslo Marathon', 'Marathon', 'Oslo', 'Norway'],
  ['oslo_half_marathon', 'Oslo Half Marathon', 'Half Marathon', 'Oslo', 'Norway'],
  ['oslo_10km', 'Oslo 10 KM', '10 KM', 'Oslo', 'Norway'],
  ['bogota_half_marathon', 'Bogotá Half Marathon', 'Half Marathon', 'Bogotá', 'Colombia'],
  ['bogota_10km', 'Bogotá 10 KM', '10 KM', 'Bogotá', 'Colombia'],
  ['houilles_10km', 'Houilles 10 KM', '10 KM', 'Houilles', 'France'],
  ['houilles_5km', 'Houilles 5 KM', '5 KM', 'Houilles', 'France']
];

function seedRoutes() {
  let done = [];
  try { done = JSON.parse(getSetting('seed_done') || '[]'); } catch { done = []; }
  let n = 0;
  LIST.forEach(([file, name, sport, place, country], i) => {
    if (done.includes(file)) return;
    try {
      const f = path.join(DIR, file + '.gpx');
      if (!fs.existsSync(f)) return;
      const pts = routesLib.parseGpx(fs.readFileSync(f, 'utf8'));
      if (pts.length < 5) return;
      const simple = routesLib.simplify(pts, 3, 2500);
      db.prepare('INSERT INTO routes(id,name,sport,place,country,distance_km,points_json,sort) VALUES(?,?,?,?,?,?,?,?)')
        .run('seed-' + file, name, sport, place, country, routesLib.distanceKm(pts), JSON.stringify(simple), i);
      done.push(file); n++;
    } catch (e) { console.error('[seed-routes]', file, e.message); }
  });
  if (n) { setSetting('seed_done', JSON.stringify(done)); console.log('[seed-routes] toegevoegd:', n); }
}
module.exports = { seedRoutes };
