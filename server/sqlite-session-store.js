'use strict';

const session = require('express-session');
const db = require('./database');
const { getSessionExpiry } = require('./session-config');

// Small persistent session store using the same SQLite database as the hotel app.
// This avoids express-session's development-only MemoryStore and adds no dependency.
class SQLiteSessionStore extends session.Store {
  constructor() {
    super();
    this.writesSinceCleanup = 0;
    this.getStatement = db.prepare('SELECT sess, expire FROM web_sessions WHERE sid = ?');
    this.setStatement = db.prepare(`INSERT INTO web_sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`);
    this.touchStatement = db.prepare('UPDATE web_sessions SET expire = ? WHERE sid = ?');
    this.destroyStatement = db.prepare('DELETE FROM web_sessions WHERE sid = ?');
    this.cleanupStatement = db.prepare('DELETE FROM web_sessions WHERE expire <= ?');
  }

  expiry(sessionData) {
    return getSessionExpiry(sessionData);
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expire <= Date.now()) {
        this.destroyStatement.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) { return callback(error); }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      this.setStatement.run(sid, JSON.stringify(sessionData), this.expiry(sessionData));
      this.writesSinceCleanup += 1;
      if (this.writesSinceCleanup >= 100) {
        this.cleanupStatement.run(Date.now());
        this.writesSinceCleanup = 0;
      }
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      this.touchStatement.run(this.expiry(sessionData), sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { this.destroyStatement.run(sid); callback(null); }
    catch (error) { callback(error); }
  }
}

module.exports = SQLiteSessionStore;
