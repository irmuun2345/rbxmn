// The short-lived Roblox OAuth handshake. Not to be confused with express_sessions,
// which holds logged-in browser sessions and lives in middleware/session-store.js.
module.exports = (db) => ({
  // Create a session
  createSession: (sessionId, userId, sessionData, expiresAt, callback) => {
    const sql = `INSERT OR REPLACE INTO sessions (id, user_id, session_data, expires_at) VALUES (?, ?, ?, ?)`;
    const expiresAtTimestamp = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt);
    db.run(sql, [sessionId, userId, sessionData, expiresAtTimestamp], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID });
      }
    });
  },

  // Get session by ID
  getSessionById: (sessionId, callback) => {
    const sql = `SELECT * FROM sessions WHERE id = ? AND CAST(expires_at AS INTEGER) > ?`;
    db.get(sql, [sessionId, Date.now()], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  // Delete expired sessions
  deleteExpiredSessions: (callback) => {
    const sql = `DELETE FROM sessions WHERE CAST(expires_at AS INTEGER) <= ?`;
    db.run(sql, [Date.now()], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { deleted: this.changes });
      }
    });
  },
});
