// The 14-day payout clock: when someone joined, and whether that record is still true.
module.exports = (db) => ({
  // INSERT OR IGNORE, never REPLACE: if a row already exists, the original
  // joined_at must survive. Re-recording a membership would silently reset
  // the buyer's clock and push their eligibility 14 days into the future.
  recordGroupMembership: (userId, robloxId, groupId, joinedAt, source, callback) => {
    const sql = `INSERT OR IGNORE INTO group_memberships
      (user_id, roblox_id, group_id, joined_at, source)
      VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [userId, String(robloxId), String(groupId), joinedAt, source], function(err) {
      callback(err, err ? null : { id: this.lastID, inserted: this.changes > 0 });
    });
  },

  getGroupMembership: (userId, groupId, callback) => {
    db.get(
      `SELECT * FROM group_memberships WHERE user_id = ? AND group_id = ?`,
      [userId, String(groupId)],
      callback
    );
  },

  touchGroupMembership: (userId, groupId, callback) => {
    db.run(
      `UPDATE group_memberships SET last_verified_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND group_id = ?`,
      [userId, String(groupId)],
      function(err) { callback(err, err ? null : { changes: this.changes }); }
    );
  },

  // Admin support view — someone who left and rejoined needs their clock
  // cleared by hand, and there's no way to detect that from the API.
  deleteGroupMembership: (userId, groupId, callback) => {
    db.run(
      `DELETE FROM group_memberships WHERE user_id = ? AND group_id = ?`,
      [userId, String(groupId)],
      function(err) { callback(err, err ? null : { changes: this.changes }); }
    );
  },

  getAllGroupMemberships: (callback) => {
    const sql = `SELECT m.*, u.username,
        CAST((julianday('now') - julianday(m.joined_at)) AS INTEGER) AS days_in_group
      FROM group_memberships m
      JOIN users u ON u.id = m.user_id
      ORDER BY m.joined_at DESC`;
    db.all(sql, [], callback);
  },

  // ---------------------------------------------------------------------
  // Receipts
  // ---------------------------------------------------------------------
});
