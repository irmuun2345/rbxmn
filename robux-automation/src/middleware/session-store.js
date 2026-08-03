const session = require('express-session');
const { db } = require('../models/db');

// express-session's default MemoryStore is explicitly not for production: it
// leaks (nothing ever evicts an expired entry) and every restart logs every
// admin out. connect-sqlite3 would be the obvious fix but it peer-depends on
// sqlite3@5 while this project runs sqlite3@6, so the store is implemented
// here against the connection the rest of the app already uses.
//
// Sessions live in their own table rather than the existing `sessions` one —
// that table belongs to the Roblox OAuth QR handshake and has a different
// shape and lifetime.
const TABLE = 'express_sessions';

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`, (error) => {
    if (error) console.error('Error creating express_sessions table:', error.message);
  });

  db.run(`CREATE INDEX IF NOT EXISTS idx_express_sessions_expires
    ON ${TABLE} (expires_at)`, (error) => {
    if (error) console.error('Error indexing express_sessions:', error.message);
  });
});

class SqliteSessionStore extends session.Store {
  constructor({ ttlMs, sweepIntervalMs = 15 * 60 * 1000 }) {
    super();
    this.ttlMs = ttlMs;

    // Expired rows are removed on a timer as well as on read, because a
    // session that is never touched again would otherwise sit there forever.
    // unref() so this timer alone can't hold the process open.
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  expiryFor(sess) {
    const cookieExpires = sess?.cookie?.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + this.ttlMs;
  }

  sweep() {
    db.run(`DELETE FROM ${TABLE} WHERE expires_at <= ?`, [Date.now()], (error) => {
      if (error) console.error('Session sweep error:', error.message);
    });
  }

  get(sid, callback) {
    db.get(`SELECT data, expires_at FROM ${TABLE} WHERE sid = ?`, [sid], (error, row) => {
      if (error) return callback(error);
      if (!row) return callback(null, null);

      // An expired row is treated as absent and dropped, so a stale cookie
      // can never resurrect an old admin session.
      if (row.expires_at <= Date.now()) {
        return this.destroy(sid, () => callback(null, null));
      }

      try {
        callback(null, JSON.parse(row.data));
      } catch (parseError) {
        // Corrupt row: discard it rather than 500 on every request.
        this.destroy(sid, () => callback(null, null));
      }
    });
  }

  set(sid, sess, callback = () => {}) {
    let data;
    try {
      data = JSON.stringify(sess);
    } catch (error) {
      return callback(error);
    }

    db.run(
      `INSERT INTO ${TABLE} (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      [sid, data, this.expiryFor(sess)],
      callback
    );
  }

  touch(sid, sess, callback = () => {}) {
    db.run(
      `UPDATE ${TABLE} SET expires_at = ? WHERE sid = ?`,
      [this.expiryFor(sess), sid],
      callback
    );
  }

  destroy(sid, callback = () => {}) {
    db.run(`DELETE FROM ${TABLE} WHERE sid = ?`, [sid], callback);
  }

  clear(callback = () => {}) {
    db.run(`DELETE FROM ${TABLE}`, callback);
  }

  length(callback) {
    db.get(`SELECT COUNT(*) AS count FROM ${TABLE} WHERE expires_at > ?`, [Date.now()], (error, row) => {
      if (error) return callback(error);
      callback(null, row.count);
    });
  }
}

module.exports = { SqliteSessionStore };
