// Zet de meegeleverde standaardroutes (seed-routes/*.gpx) in de database, als ze er nog niet in staan (op naam).
// Wijzigingen in de admin (hernoemen, verbergen, teksten) blijven bestaan; verwijderde routes komen niet terug zolang de naam in 'seed_done' staat.
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('./db');
const routesLib = require('./routes');

const DIR = path.join(__dirname, '..', 'seed-routes');
const LIST = [
  ['rotterdam_marathon', 'Rotterdam Marathon', 'Marathon', 'Rotterdam', 'Netherlands'],
  ['enschede_marathon', 'Enschede Marathon', 'Marathon', 'Enschede', 'Netherlands'],
  ['munich_marathon', 'Munich Marathon', 'Marathon', 'Munich', 'Germany'],
  ['munich_half_marathon', 'Munich Halve Marathon', 'Halve Marathon', 'Munich', 'Germany'],
  ['munich_10km', 'Munich 10 KM', '10KM', 'Munich', 'Germany'],
  ['oslo_marathon', 'Oslo Marathon', 'Marathon', 'Oslo', 'Norway'],
  ['oslo_half_marathon', 'Oslo Halve Marathon', 'Halve Marathon', 'Oslo', 'Norway'],
  ['oslo_10km', 'Oslo 10 KM', '10KM', 'Oslo', 'Norway'],
  ['houilles_10km', 'Houilles 10 KM', '10KM', 'Houilles', 'France'],
  ['houilles_5km', 'Houilles 5 KM', '5KM', 'Houilles', 'France'],
  ['amsterdam_marathon', 'Amsterdam Marathon', 'Marathon', 'Amsterdam', 'Netherlands'],
  ['eindhoven_marathon', 'Eindhoven Marathon', 'Marathon', 'Eindhoven', 'Netherlands'],
  ['eindhoven_quarter_marathon', 'Eindhoven Quarter Marathon', 'Quarter Marathon', 'Eindhoven', 'Netherlands'],
  ['eindhoven_5km', 'Eindhoven 5 KM', '5KM', 'Eindhoven', 'Netherlands'],
  ['eindhoven_urban_walk_25km', 'Eindhoven Urban Walk 2,5 KM', 'Urban Walk', 'Eindhoven', 'Netherlands'],
  ['eindhoven_urban_walk_15km', 'Eindhoven Urban Walk 1,5 KM', 'Urban Walk', 'Eindhoven', 'Netherlands'],
  ['kustmarathon_zeeland', 'Kustmarathon Zeeland', 'Marathon', 'Zeeland', 'Netherlands'],
  ['berlin_marathon', 'Berlin Marathon', 'Marathon', 'Berlin', 'Germany'],
  ['eindhoven_half_marathon', 'Eindhoven Halve Marathon', 'Halve Marathon', 'Eindhoven', 'Netherlands'],
  ['enschede_half_marathon', 'Enschede Halve Marathon', 'Halve Marathon', 'Enschede', 'Netherlands'],
  ['venloop_5km', 'Venloop 5 KM', '5KM', 'Venlo', 'Netherlands'],
  ['venloop_10km', 'Venloop 10 KM', '10KM', 'Venlo', 'Netherlands'],
  ['venloop_half_marathon', 'Venloop Halve Marathon', 'Halve Marathon', 'Venlo', 'Netherlands'],
  ['zevenheuvelennacht_7km', 'Zevenheuvelennacht 7 KM', '7KM', 'Nijmegen', 'Netherlands'],
  ['zevenheuvelenloop_15km', 'Zevenheuvelenloop 15 KM', '15KM', 'Nijmegen', 'Netherlands'],
  ['rotterdam_10km', 'Rotterdam 10 KM', '10KM', 'Rotterdam', 'Netherlands'],
  ['rotterdam_city_run_4_2km', 'Rotterdam City Run 4,2 KM', 'City Run', 'Rotterdam', 'Netherlands'],
  ['new_york_city_marathon', 'New York City Marathon', 'Marathon', 'New York', 'United States'],
  ['malaga_marathon', 'Málaga Marathon', 'Marathon', 'Málaga', 'Spain']
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
  if (!getSetting('seed_bogota_removed')) {
    try { db.prepare("DELETE FROM routes WHERE id IN ('seed-bogota_half_marathon','seed-bogota_10km')").run(); setSetting('seed_bogota_removed', '1'); }
    catch (e) { console.error('[seed-routes] bogota', e.message); }
  }
  if (!getSetting('seed_km_rename')) {
    try {
      db.prepare("UPDATE routes SET sport=REPLACE(sport,' KM','KM') WHERE id LIKE 'seed-%' AND sport LIKE '% KM'").run();
      setSetting('seed_km_rename', '1');
    } catch (e) { console.error('[seed-routes] km', e.message); }
  }
  if (!getSetting('seed_halve_rename')) {
    try {
      db.prepare("UPDATE routes SET name=REPLACE(name,'Half Marathon','Halve Marathon') WHERE id LIKE 'seed-%' AND name LIKE '%Half Marathon%'").run();
      db.prepare("UPDATE routes SET sport='Halve Marathon' WHERE id LIKE 'seed-%' AND sport='Half Marathon'").run();
      setSetting('seed_halve_rename', '1');
    } catch (e) { console.error('[seed-routes] rename', e.message); }
  }
  if (n) { setSetting('seed_done', JSON.stringify(done)); console.log('[seed-routes] toegevoegd:', n); }
}
module.exports = { seedRoutes };
