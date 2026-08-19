const session = require('express-session');
const { Store } = session;

// Bewaart login-sessies in dezelfde SQLite-database als de orders (dus ook op
// de permanente Railway-Volume, zie DATA_DIR in db.js) — in plaats van in het
// geheugen van het serverproces. Zonder dit zou IEDEREEN automatisch worden
// uitgelogd bij elke herstart van de server (bv. na elke nieuwe deploy),
// ongeacht hoe lang de sessie-cookie zelf nog geldig is.
class SqliteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER
      )
    `);
    // Verlopen sessies af en toe opruimen (1x per uur), anders groeit deze
    // tabel ongelimiteerd door. .unref() zorgt dat deze timer het proces niet
    // kunstmatig actief houdt (bv. bij het afsluiten van de server).
    this.cleanupInterval = setInterval(() => {
      try {
        this.db.prepare('DELETE FROM sessions WHERE expires IS NOT NULL AND expires < ?').run(Date.now());
      } catch (e) {
        // niet kritiek, gewoon volgende keer opnieuw proberen
      }
    }, 60 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires && row.expires < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sess), expires);
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SqliteSessionStore;
