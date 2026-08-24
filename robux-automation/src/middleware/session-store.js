const session = require('express-session');
const { db } = require('../models/db');
const { EXPRESS_SESSION_TABLE } = require('../models/schema/core');

// express-session's default MemoryStore is explicitly not for production: it
// leaks (nothing ever evicts an expired entry) and every restart logs every
// admin out. So the store is implemented here against the connection the rest
// of the app already uses.
//
// Sessions live in their own table rather than the existing `sessions` one —
// that table belongs to the Roblox OAuth QR handshake and has a different
// shape and lifetime.
//
// The table itself is created by the schema layer, not here. It used to be
// built at require() time, which on a serverless deployment meant every cold
// start racing every other cold start to CREATE TABLE — see the note in
// models/db.js.
const TABLE = EXPRESS_SESSION_TABLE;

class PostgresSessionStore extends session.Store {
  constructor({ ttlMs, sweepIntervalMs = 15 * 60 * 1000 }) {
    super();
    this.ttlMs = ttlMs;

    // Expired rows are removed on a timer as well as on read, because a
    // session that is never touched again would otherwise sit there forever.
    // unref() so this timer alone can't hold the process open.
    //
    // A serverless instance is frozen between requests, so this timer fires
    // rarely there if at all. That is why sweep() is also called from the
    // cron route, and why get() drops an expired row it reads: neither the
    // correctness of expiry nor the cleanup depends on this interval.
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

module.exports = { PostgresSessionStore };
