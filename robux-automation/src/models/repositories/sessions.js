// The short-lived Roblox OAuth handshake. Not to be confused with express_sessions,
// which holds logged-in browser sessions and lives in middleware/session-store.js.
module.exports = (db) => ({
  // Create a session
  createSession: (sessionId, userId, sessionData, expiresAt, callback) => {
    // Re-issuing a handshake for an id that already exists overwrites it, so
    // this is the one place an upsert is intended rather than avoided.
    const sql = `INSERT INTO sessions (id, user_id, session_data, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        session_data = EXCLUDED.session_data,
        expires_at = EXCLUDED.expires_at`;
    const expiresAtTimestamp = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt);
    db.run(sql, [sessionId, userId, sessionData, expiresAtTimestamp], function(err) {
      if (err) {
        callback(err, null);
      } else {
        // The id is the caller's own sessionId, not a generated key.
        callback(null, { id: sessionId });
      }
    });
  },

  // Get session by ID
  getSessionById: (sessionId, callback) => {
    const sql = `SELECT * FROM sessions WHERE id = ? AND expires_at > ?`;
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
    const sql = `DELETE FROM sessions WHERE expires_at <= ?`;
    db.run(sql, [Date.now()], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { deleted: this.changes });
      }
    });
  },
});
