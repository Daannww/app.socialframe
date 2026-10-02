// --- Schrijfmachine (handgeschreven kaartjes) ---
//
// Het dashboard draait op Railway en kan dus niet zelf bij de USB-poort van
// de schrijfmachine (die hangt aan een Mac in de werkplaats). Daarom werkt
// het met een wachtrij:
//   1. In het tabblad "Kaartjes" maak je een kaartje aan (tekst + sjabloon)
//      en druk je op "Schrijven" -> status 'wachtrij'.
//   2. De schrijfagent op de Mac (schrijfmachine/agent.py) vraagt elke paar
//      seconden POST /api/schrijfagent/volgende of er iets klaarstaat, schrijft
//      het en meldt daarna 'klaar' of 'fout' terug.
// De agent logt niet in met een sessie maar met een geheime sleutel in de
// header X-Schrijf-Token, die gelijk moet zijn aan de Railway-variabele
// SCHRIJF_AGENT_TOKEN.

const crypto = require('crypto');
const { db } = require('./db');

// Sjablonen: afmetingen in mm. Het nulpunt is de linkerbovenhoek (buitenkant)
// van het vak, daar zet je de pen op de machine neer. Een nieuw sjabloon
// toevoegen = hier een regel bij. 'type' 'tekstvak' = alleen het bericht,
// automatisch passend gemaakt; 'ansichtkaart' = bericht links + adres rechts.
const SJABLONEN = {
  tekstvak: { naam: 'Tekstvak 110 × 120 mm', type: 'tekstvak', breed: 110, hoog: 120, marge: 3, centreren: true, letterhoogte: 4.0 },
  vierkant: { naam: 'Vierkant 80 × 80 mm', type: 'tekstvak', breed: 80, hoog: 80, marge: 3, centreren: true, letterhoogte: 3.4 },
  ansichtkaart: { naam: 'Ansichtkaart A6 met adres', type: 'ansichtkaart', breed: 148, hoog: 105, marge: 8 }
};

// Lijn-lettertypes (enkele pennenstreek per letter). Moeten zowel hier in
// public/schrijffonts/<naam>.svg staan (voor het voorbeeld) als op de Mac in
// schrijfmachine/fonts/ (om echt te schrijven).
const LETTERTYPES = ['IndieFlower', 'Caveat', 'LaBelleAurore', 'DancingScript', 'AmsterdamSlant', 'Amsterdam',
  'HomemadeApple', 'NothingYouCouldDo', 'Kalam', 'ReenieBeanie', 'EMSAllure', 'EMSFelix'];

const STANDAARD_TEKST = 'Lieve {voornaam},\n\nBedankt voor je bestelling! We hebben hem met veel liefde voor je gemaakt. Veel plezier ermee!\n\nGroetjes,\nTeam Socialframe';

db.exec(`
CREATE TABLE IF NOT EXISTS schrijf_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  order_number TEXT,
  naam TEXT,
  adres_json TEXT,
  tekst TEXT NOT NULL,
  sjabloon TEXT NOT NULL,
  lettertype TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'concept',
  fout TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  geschreven_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_schrijf_jobs_status ON schrijf_jobs(status);

CREATE TABLE IF NOT EXISTS schrijf_teksten (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  naam TEXT NOT NULL,
  tekst TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

if (db.prepare('SELECT COUNT(*) AS c FROM schrijf_teksten').get().c === 0) {
  db.prepare('INSERT INTO schrijf_teksten (naam, tekst) VALUES (?, ?)').run('Standaard bedankje', STANDAARD_TEKST);
}

// Een job die langer dan 15 minuten op 'bezig' staat is waarschijnlijk
// achtergebleven (Mac uitgezet tijdens het schrijven) -> terug naar 'fout'.
function ruimHangendeJobsOp() {
  db.prepare(`UPDATE schrijf_jobs SET status = 'fout', fout = 'Geen terugmelding van de schrijfagent (Mac uit of verbinding weg?)',
              updated_at = datetime('now')
              WHERE status = 'bezig' AND updated_at < datetime('now', '-15 minutes')`).run();
}

function jobNaarJson(j) {
  return {
    id: j.id,
    order_id: j.order_id,
    order_number: j.order_number,
    naam: j.naam,
    adres: JSON.parse(j.adres_json || '[]'),
    tekst: j.tekst,
    sjabloon: j.sjabloon,
    lettertype: j.lettertype,
    status: j.status,
    fout: j.fout,
    created_at: j.created_at,
    updated_at: j.updated_at,
    geschreven_at: j.geschreven_at
  };
}

// "Kaart ligt klaar"-vlag: de machine heeft (nog) geen automatische invoer,
// dus na elk kaartje moet iemand een nieuw kaartje neerleggen. De agent krijgt
// pas een volgende job als deze vlag aan staat; bij het uitdelen gaat hij weer
// uit. Hij gaat aan als je op "Schrijven" drukt of op "Volgende kaartje ligt
// klaar". (Met automatische invoer stuurt de agent automatische_invoer: true
// mee en wordt de vlag genegeerd.)
function zetMeta(key, value) {
  db.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function kaartLigtKlaar() {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'schrijf_kaart_klaar'").get();
  return !!row && row.value === '1';
}

function agentLaatstGezien() {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'schrijfagent_last_seen'").get();
  return row ? row.value : null;
}

// Wordt aangeroepen vanuit shopify.js se syncOrders() zodra een NIEUWE order
// een "Handgeschreven kaartje toevoegen."-regel met een ingevulde boodschap
// bevat — maakt daar automatisch een concept-kaartje van, zodat de
// klant-boodschap niet met de hand vanuit Shopify overgetypt hoeft te
// worden in het tabblad "Kaartjes". Bewust status 'concept' (niet
// 'wachtrij'): er moet nog even een sjabloon/lettertype gekozen en de tekst
// kort gecontroleerd worden voordat de schrijfmachine 'm echt schrijft —
// precies zoals een handmatig aangemaakt kaartje dat ook eerst als concept
// doet. Sjabloon 'tekstvak' (alleen de boodschap, geen adres) omdat het
// kaartje gewoon in hetzelfde pakket meegaat — er is geen postadres nodig.
// Geeft `null` terug (en doet niets) als er al een kaartje voor deze order
// bestaat, als extra vangnet tegen dubbele kaartjes bij een herhaalde sync
// (al roept syncOrders() dit toch alleen aan bij isNew-orders).
function maakConceptJobUitOrder({ order_id, order_number, naam, tekst }) {
  if (!tekst || !String(tekst).trim()) return null;
  if (order_id) {
    const bestaat = db.prepare('SELECT id FROM schrijf_jobs WHERE order_id = ?').get(order_id);
    if (bestaat) return null;
  }
  const lettertype = LETTERTYPES[0];
  const r = db.prepare(`INSERT INTO schrijf_jobs (order_id, order_number, naam, adres_json, tekst, sjabloon, lettertype, status)
                        VALUES (?, ?, ?, '[]', ?, 'tekstvak', ?, 'concept')`)
    .run(order_id || null, order_number || null, naam || null, String(tekst).slice(0, 2000), lettertype);
  return r.lastInsertRowid;
}

// --- Routes voor de schrijfagent (GEEN sessie, wel token). Moet vóór
// app.use(requireAuth) geregistreerd worden. ---
function registreerAgentRoutes(app) {
  function vereisToken(req, res, next) {
    const verwacht = process.env.SCHRIJF_AGENT_TOKEN;
    if (!verwacht) return res.status(503).json({ error: 'SCHRIJF_AGENT_TOKEN is niet ingesteld op de server' });
    const gekregen = String(req.get('X-Schrijf-Token') || '');
    const a = Buffer.from(gekregen);
    const b = Buffer.from(verwacht);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Ongeldige schrijfagent-sleutel' });
    }
    next();
  }

  // Volgende job ophalen (en meteen op 'bezig' zetten, zodat 'm niet twee
  // keer geschreven wordt). Telt ook als "teken van leven" van de agent.
  app.post('/api/schrijfagent/volgende', vereisToken, (req, res) => {
    try {
      db.prepare("INSERT INTO sync_meta (key, value) VALUES ('schrijfagent_last_seen', datetime('now')) " +
                 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
      ruimHangendeJobsOp();
      const automatisch = !!(req.body && req.body.automatische_invoer);
      const pak = db.transaction(() => {
        const job = db.prepare("SELECT * FROM schrijf_jobs WHERE status = 'wachtrij' ORDER BY updated_at ASC, id ASC LIMIT 1").get();
        if (!job) return { job: null };
        if (!automatisch && !kaartLigtKlaar()) return { job: null, wacht_op_kaart: true };
        zetMeta('schrijf_kaart_klaar', '0');
        db.prepare("UPDATE schrijf_jobs SET status = 'bezig', fout = NULL, updated_at = datetime('now') WHERE id = ?").run(job.id);
        return { job: db.prepare('SELECT * FROM schrijf_jobs WHERE id = ?').get(job.id) };
      });
      const { job, wacht_op_kaart } = pak();
      if (!job) return res.json({ job: null, wacht_op_kaart: !!wacht_op_kaart });
      const sjabloon = SJABLONEN[job.sjabloon] || SJABLONEN.tekstvak;
      res.json({ job: { ...jobNaarJson(job), sjabloon_instellingen: { id: job.sjabloon, ...sjabloon } } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/schrijfagent/jobs/:id', vereisToken, (req, res) => {
    try {
      const { status, fout } = req.body || {};
      if (!['klaar', 'fout'].includes(status)) return res.status(400).json({ error: "status moet 'klaar' of 'fout' zijn" });
      db.prepare(`UPDATE schrijf_jobs SET status = ?, fout = ?, updated_at = datetime('now'),
                  geschreven_at = CASE WHEN ? = 'klaar' THEN datetime('now') ELSE geschreven_at END
                  WHERE id = ?`).run(status, status === 'fout' ? String(fout || 'Onbekende fout').slice(0, 500) : null, status, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// --- Routes voor het dashboard (achter requireAuth) ---
function registreerDashboardRoutes(app) {
  app.get('/api/schrijfmachine/info', (req, res) => {
    const laatst = agentLaatstGezien();
    let online = false;
    if (laatst) {
      const sec = (Date.now() - new Date(laatst.replace(' ', 'T') + 'Z').getTime()) / 1000;
      online = sec < 20;
    }
    const tel = db.prepare("SELECT SUM(status = 'wachtrij') AS wachtrij, SUM(status = 'bezig') AS bezig FROM schrijf_jobs").get();
    res.json({
      sjablonen: SJABLONEN,
      lettertypes: LETTERTYPES,
      agent: { laatst_gezien: laatst, online, token_ingesteld: !!process.env.SCHRIJF_AGENT_TOKEN },
      wachtrij: { aantal: tel.wachtrij || 0, bezig: tel.bezig || 0, kaart_klaar: kaartLigtKlaar() }
    });
  });

  app.get('/api/schrijfmachine/jobs', (req, res) => {
    try {
      ruimHangendeJobsOp();
      const jobs = db.prepare(`SELECT * FROM schrijf_jobs
        WHERE status != 'klaar' OR geschreven_at > datetime('now', '-3 days')
        ORDER BY CASE status WHEN 'bezig' THEN 0 WHEN 'wachtrij' THEN 1 WHEN 'fout' THEN 2 WHEN 'concept' THEN 3 ELSE 4 END,
                 updated_at DESC LIMIT 200`).all();
      res.json(jobs.map(jobNaarJson));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/schrijfmachine/jobs', (req, res) => {
    try {
      const { order_id, order_number, naam, adres, tekst, sjabloon, lettertype, direct } = req.body || {};
      if (!tekst || !String(tekst).trim()) return res.status(400).json({ error: 'Tekst is verplicht' });
      if (!SJABLONEN[sjabloon]) return res.status(400).json({ error: 'Onbekend sjabloon' });
      if (!LETTERTYPES.includes(lettertype)) return res.status(400).json({ error: 'Onbekend lettertype' });
      const r = db.prepare(`INSERT INTO schrijf_jobs (order_id, order_number, naam, adres_json, tekst, sjabloon, lettertype, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(order_id || null, order_number || null, naam || null, JSON.stringify(Array.isArray(adres) ? adres : []),
             String(tekst).slice(0, 2000), sjabloon, lettertype, direct ? 'wachtrij' : 'concept');
      if (direct) zetMeta('schrijf_kaart_klaar', '1');
      res.json(jobNaarJson(db.prepare('SELECT * FROM schrijf_jobs WHERE id = ?').get(r.lastInsertRowid)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Status wijzigen vanuit het dashboard: 'wachtrij' (= schrijven), 'concept'
  // (= terugzetten / uit de wachtrij halen). 'bezig' kan niet handmatig.
  app.post('/api/schrijfmachine/jobs/:id/status', (req, res) => {
    try {
      const { status } = req.body || {};
      if (!['wachtrij', 'concept'].includes(status)) return res.status(400).json({ error: 'Ongeldige status' });
      const job = db.prepare('SELECT * FROM schrijf_jobs WHERE id = ?').get(req.params.id);
      if (!job) return res.status(404).json({ error: 'Kaartje niet gevonden' });
      if (job.status === 'bezig') return res.status(409).json({ error: 'Dit kaartje wordt nu geschreven' });
      db.prepare("UPDATE schrijf_jobs SET status = ?, fout = NULL, updated_at = datetime('now') WHERE id = ?").run(status, job.id);
      if (status === 'wachtrij') zetMeta('schrijf_kaart_klaar', '1');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/schrijfmachine/kaart-klaar', (req, res) => {
    zetMeta('schrijf_kaart_klaar', '1');
    res.json({ ok: true });
  });

  app.delete('/api/schrijfmachine/jobs/:id', (req, res) => {
    try {
      const job = db.prepare('SELECT status FROM schrijf_jobs WHERE id = ?').get(req.params.id);
      if (job && job.status === 'bezig') return res.status(409).json({ error: 'Dit kaartje wordt nu geschreven' });
      db.prepare('DELETE FROM schrijf_jobs WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Opgeslagen teksten
  app.get('/api/schrijfmachine/teksten', (req, res) => {
    res.json(db.prepare('SELECT * FROM schrijf_teksten ORDER BY naam COLLATE NOCASE').all());
  });

  app.post('/api/schrijfmachine/teksten', (req, res) => {
    try {
      const { naam, tekst } = req.body || {};
      if (!naam || !String(naam).trim() || !tekst || !String(tekst).trim()) {
        return res.status(400).json({ error: 'Naam en tekst zijn verplicht' });
      }
      const bestaand = db.prepare('SELECT id FROM schrijf_teksten WHERE naam = ?').get(String(naam).trim());
      if (bestaand) {
        db.prepare('UPDATE schrijf_teksten SET tekst = ? WHERE id = ?').run(String(tekst).slice(0, 2000), bestaand.id);
      } else {
        db.prepare('INSERT INTO schrijf_teksten (naam, tekst) VALUES (?, ?)').run(String(naam).trim(), String(tekst).slice(0, 2000));
      }
      res.json(db.prepare('SELECT * FROM schrijf_teksten ORDER BY naam COLLATE NOCASE').all());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/schrijfmachine/teksten/:id', (req, res) => {
    db.prepare('DELETE FROM schrijf_teksten WHERE id = ?').run(req.params.id);
    res.json(db.prepare('SELECT * FROM schrijf_teksten ORDER BY naam COLLATE NOCASE').all());
  });
}

module.exports = { registreerAgentRoutes, registreerDashboardRoutes, SJABLONEN, LETTERTYPES, maakConceptJobUitOrder };
