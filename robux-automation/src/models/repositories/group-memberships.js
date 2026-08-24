// The 14-day payout clock: when someone joined, and whether that record is still true.
module.exports = (db) => ({
  // DO NOTHING, never DO UPDATE: if a row already exists, the original
  // joined_at must survive. Re-recording a membership would silently reset
  // the buyer's clock and push their eligibility 14 days into the future.
  recordGroupMembership: (userId, robloxId, groupId, joinedAt, source, callback) => {
    const sql = `INSERT INTO group_memberships
      (user_id, roblox_id, group_id, joined_at, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, group_id) DO NOTHING`;
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

  // Replaces a guessed join date with one Roblox actually confirmed.
  //
  // recordGroupMembership is deliberately DO NOTHING, so it can never move an
  // existing clock. This is the one sanctioned exception, and it is guarded so
  // it can only ever be used the safe way:
  //
  //   source = 'observed'  — only rows holding a guess are touched. A row we
  //                          set from an accepted join request, or one already
  //                          corrected, is left exactly as it is.
  //   joined_at > ?        — the new date must be *earlier* than the stored
  //                          one. That makes this strictly a correction of an
  //                          over-estimate. Nothing here can ever push someone
  //                          further from eligibility, and no caller can use
  //                          it to reset a clock.
  //
  // Both conditions live in the WHERE clause rather than in JavaScript so the
  // guarantee holds even if a future caller forgets them.
  correctObservedJoinDate: (userId, groupId, joinedAt, source, callback) => {
    db.run(
      `UPDATE group_memberships
          SET joined_at = ?, source = ?
        WHERE user_id = ? AND group_id = ?
          AND source = 'observed'
          AND joined_at > ?`,
      [joinedAt, source, userId, String(groupId), joinedAt],
      function(err) { callback(err, err ? null : { changes: this.changes }); }
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
        FLOOR(EXTRACT(EPOCH FROM (NOW() - m.joined_at)) / 86400)::INTEGER AS days_in_group
      FROM group_memberships m
      JOIN users u ON u.id = m.user_id
      ORDER BY m.joined_at DESC`;
    db.all(sql, [], callback);
  },

  // ---------------------------------------------------------------------
  // Receipts
  // ---------------------------------------------------------------------
});
