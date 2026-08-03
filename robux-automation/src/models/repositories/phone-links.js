// One phone number to one Roblox account. The UNIQUE index is what stops a single
// discount level being spread across several accounts.
module.exports = (db) => ({
  // Link phone number to user. Plain INSERT (not OR REPLACE) so it fails
  // outright — via the UNIQUE constraints — if that phone is already linked
  // to a different user, or if this user already has a different phone
  // linked. That's the enforcement: 1 phone <-> 1 Roblox account, permanently,
  // until an admin unlinks it.
  linkPhoneNumber: (phoneNumber, userId, callback) => {
    const sql = `INSERT INTO phone_links (phone_number, user_id) VALUES (?, ?)`;
    db.run(sql, [phoneNumber, userId], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID, phoneNumber, userId });
      }
    });
  },

  // Get user by phone number
  getUserByPhoneNumber: (phoneNumber, callback) => {
    const sql = `SELECT u.* FROM users u JOIN phone_links p ON u.id = p.user_id WHERE p.phone_number = ?`;
    db.get(sql, [phoneNumber], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  // Check if phone number is already linked
  isPhoneNumberLinked: (phoneNumber, callback) => {
    const sql = `SELECT COUNT(*) as count FROM phone_links WHERE phone_number = ?`;
    db.get(sql, [phoneNumber], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row.count > 0);
      }
    });
  },

  // The phone link for a specific user, if any — used to gate order/gift
  // card actions on "has this account linked a phone yet?".
  getPhoneLinkByUserId: (userId, callback) => {
    db.get(`SELECT * FROM phone_links WHERE user_id = ?`, [userId], (err, row) => {
      callback(err, err ? null : row);
    });
  },

  // Admin-only: every phone/Roblox-account pairing, for the support view.
  getAllPhoneLinks: (callback) => {
    const sql = `SELECT p.*, u.username, u.roblox_id FROM phone_links p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC`;
    db.all(sql, [], callback);
  },

  // Admin-only escape hatch for legitimate cases (lost phone, sold account).
  // Customers can never call this themselves.
  unlinkPhoneByUserId: (userId, callback) => {
    db.run(`DELETE FROM phone_links WHERE user_id = ?`, [userId], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  // ---------------------------------------------------------------------
  // Fixed Robux packages
  // ---------------------------------------------------------------------
});
