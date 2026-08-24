// The Roblox account that accepts group joins and sends payouts.
//
// Two columns here are secrets: `cookie` is a full Roblox session, and
// `totp_secret` is the seed that answers that account's 2-step verification.
// Both are encrypted on the way in and decrypted on the way out, so callers
// keep dealing in plain values and no route has to remember to do it — see
// services/credentials.js for what that does and does not protect.
const { encryptSecret, decryptSecret } = require('../../services/credentials');

// A row that cannot be decrypted is an error, not an empty cookie: handing
// back a blank credential would surface as "Roblox says you're not logged in"
// hours later, with nothing pointing at the key that changed.
function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    cookie: decryptSecret(row.cookie),
    totp_secret: decryptSecret(row.totp_secret)
  };
}

// Decryption throws, and these are callback-style helpers — so the throw has
// to be turned back into a callback error or it escapes into whatever is
// draining the sqlite queue.
function hydrating(callback) {
  return (error, rows) => {
    if (error) return callback(error, null);
    try {
      callback(null, Array.isArray(rows) ? rows.map(hydrate) : hydrate(rows));
    } catch (decryptError) {
      callback(decryptError, null);
    }
  };
}

module.exports = (db) => ({
  // Create seller bot
  createSellerBot: (adminId, username, robloxId, cookie, callback) => {
    const sql = `INSERT INTO seller_bots (admin_id, username, roblox_id, cookie, is_active) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [adminId, username, robloxId, encryptSecret(cookie), true], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID, adminId, username, robloxId, is_active: true });
      }
    });
  },

  // Get seller bots by admin ID
  getSellerBotsByAdminId: (adminId, callback) => {
    const sql = `SELECT * FROM seller_bots WHERE admin_id = ?`;
    db.all(sql, [adminId], hydrating(callback));
  },

  // Add or replace the bot account used for group join/payout automation.
  //
  // The 2FA secret is preserved on conflict when the caller passes null: an
  // admin refreshing an expired cookie is not also re-enrolling their
  // authenticator, and clearing it would silently break every payout the next
  // time Roblox raised a challenge.
  upsertSellerBot: (adminId, username, robloxId, cookie, totpSecret, callback) => {
    const sql = `INSERT INTO seller_bots (admin_id, username, roblox_id, cookie, totp_secret, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(username) DO UPDATE SET
        admin_id = excluded.admin_id,
        roblox_id = excluded.roblox_id,
        cookie = excluded.cookie,
        totp_secret = COALESCE(excluded.totp_secret, seller_bots.totp_secret),
        is_active = 1`;
    const encryptedSecret = totpSecret === null || totpSecret === undefined
      ? null
      : encryptSecret(totpSecret);

    db.run(sql, [adminId, username, robloxId, encryptSecret(cookie), encryptedSecret], function(err) {
      callback(err, err ? null : { id: this.lastID, adminId, username, robloxId });
    });
  },

  // Enrolling, re-enrolling, or (with null) turning 2FA handling back off.
  updateSellerBotTotpSecret: (id, totpSecret, callback) => {
    const stored = totpSecret === null || totpSecret === undefined ? null : encryptSecret(totpSecret);
    db.run(`UPDATE seller_bots SET totp_secret = ? WHERE id = ?`, [stored, id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  deactivateAllSellerBots: (callback) => {
    db.run(`UPDATE seller_bots SET is_active = 0`, [], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  getActiveSellerBot: (callback) => {
    db.get(
      `SELECT * FROM seller_bots WHERE is_active = 1 ORDER BY id DESC LIMIT 1`,
      [],
      hydrating(callback)
    );
  },

  // Get seller bot by ID
  getSellerBotById: (id, callback) => {
    db.get(`SELECT * FROM seller_bots WHERE id = ?`, [id], hydrating(callback));
  },

  // Update seller bot cookie
  updateSellerBotCookie: (id, cookie, callback) => {
    const sql = `UPDATE seller_bots SET cookie = ? WHERE id = ?`;
    db.run(sql, [encryptSecret(cookie), id], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { changes: this.changes });
      }
    });
  },

  // Deactivate seller bot
  deactivateSellerBot: (id, callback) => {
    const sql = `UPDATE seller_bots SET is_active = FALSE WHERE id = ?`;
    db.run(sql, [id], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { changes: this.changes });
      }
    });
  },
});
