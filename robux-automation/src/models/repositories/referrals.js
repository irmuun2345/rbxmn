// Codes, attributions, earnings and payouts. An earning is only ever credited once
// its order actually completes.
module.exports = (db) => ({
  // Plain INSERT, never OR REPLACE: a duplicate code must fail loudly at the
  // UNIQUE index rather than quietly reassign someone else's code.
  //
  // Terms are set at issue time because an admin issues the code — the two
  // overrides and the usage cap arrive with it rather than being edited on
  // afterwards. NULL overrides mean "follow the global setting".
  createReferralCode: (code, callback) => {
    db.run(
      `INSERT INTO referral_codes
        (user_id, code, is_influencer, bonus_percent_override,
         commission_percent_override, max_uses, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        code.userId,
        code.code,
        Boolean(code.isInfluencer),
        code.bonusPercentOverride ?? null,
        code.commissionPercentOverride ?? null,
        code.maxUses ?? 0,
        code.createdByAdminId ?? null
      ],
      function(err) {
        callback(err, err ? null : { id: this.lastID, userId: code.userId, code: code.code });
      }
    );
  },

  getReferralCodeByUserId: (userId, callback) => {
    db.get(`SELECT * FROM referral_codes WHERE user_id = ?`, [userId], callback);
  },

  // Case-insensitive so 'Sunee' and 'SUNEE' resolve to the same creator.
  // LOWER(rc.code) rather than ILIKE so this hits the unique index built on
  // exactly that expression — see schema/referrals.js.
  getReferralCodeByCode: (code, callback) => {
    db.get(
      `SELECT rc.*, u.username AS owner_username, u.roblox_id AS owner_roblox_id
       FROM referral_codes rc JOIN users u ON u.id = rc.user_id
       WHERE LOWER(rc.code) = LOWER(?)`,
      [code],
      callback
    );
  },

  getReferralCodeById: (id, callback) => {
    db.get(`SELECT * FROM referral_codes WHERE id = ?`, [id], callback);
  },

  // Lowering max_uses below the number of customers already bound is allowed
  // and simply closes the code to new ones; the customers already attributed
  // keep their terms, because retracting an attribution someone has already
  // ordered against would rewrite history.
  updateReferralCodeTerms: (id, terms, callback) => {
    const sql = `UPDATE referral_codes
      SET is_influencer = ?, bonus_percent_override = ?, commission_percent_override = ?,
          max_uses = ?, is_active = ?
      WHERE id = ?`;
    db.run(sql, [
      Boolean(terms.isInfluencer),
      terms.bonusPercentOverride,
      terms.commissionPercentOverride,
      terms.maxUses,
      Boolean(terms.isActive),
      id
    ], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  // How many customers are bound to a code. The cap is a whole-code budget,
  // so this is the number it is measured against.
  countReferralUses: (referralCodeId, callback) => {
    db.get(
      `SELECT COUNT(*) AS uses FROM referral_attributions WHERE referral_code_id = ?`,
      [referralCodeId],
      (err, row) => callback(err, err ? 0 : Number(row.uses))
    );
  },

  // The usage cap is enforced inside the INSERT rather than by counting
  // first and inserting after. Two customers redeeming the last slot of a
  // code at the same moment would both pass a separate count — here the
  // second one inserts zero rows and is told the code is spent.
  //
  // maxUses of 0 means uncapped, which is why the guard short-circuits on it.
  bindReferralAttribution: (refereeUserId, referralCodeId, referrerUserId, maxUses, callback) => {
    db.run(
      // The inserted values are cast explicitly: in INSERT ... SELECT,
      // Postgres infers parameter types from the SELECT rather than from the
      // target columns, and bare placeholders there fail to type-resolve.
      `INSERT INTO referral_attributions (referee_user_id, referral_code_id, referrer_user_id)
       SELECT ?::integer, ?::integer, ?::integer
       WHERE ?::integer = 0
          OR (SELECT COUNT(*) FROM referral_attributions WHERE referral_code_id = ?) < ?::integer`,
      [refereeUserId, referralCodeId, referrerUserId, maxUses, referralCodeId, maxUses],
      function(err) {
        callback(err, err ? null : { id: this.lastID, bound: this.changes > 0 });
      }
    );
  },

  getReferralAttribution: (refereeUserId, callback) => {
    db.get(
      `SELECT a.*, rc.code, rc.is_active, rc.is_influencer,
              rc.bonus_percent_override, rc.commission_percent_override,
              u.username AS referrer_username
       FROM referral_attributions a
       JOIN referral_codes rc ON rc.id = a.referral_code_id
       JOIN users u ON u.id = a.referrer_user_id
       WHERE a.referee_user_id = ?`,
      [refereeUserId],
      callback
    );
  },

  // Fails on the UNIQUE order_id if this order already earned — which is
  // exactly the protection we want against a retry paying twice.
  createReferralEarning: (earning, callback) => {
    const sql = `INSERT INTO referral_earnings
      (referral_code_id, referrer_user_id, referee_user_id, order_id, order_robux,
       bonus_robux, commission_robux, bonus_percent, commission_percent, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`;
    db.run(sql, [
      earning.referralCodeId,
      earning.referrerUserId,
      earning.refereeUserId,
      earning.orderId,
      earning.orderRobux,
      earning.bonusRobux,
      earning.commissionRobux,
      earning.bonusPercent,
      earning.commissionPercent
    ], function(err) { callback(err, err ? null : { id: this.lastID }); });
  },

  // Guarded on status = 'pending', so calling it twice credits once. This is
  // the line that enforces "only actually delivered top-ups count".
  creditReferralEarning: (orderId, callback) => {
    db.run(
      `UPDATE referral_earnings SET status = 'credited', credited_at = CURRENT_TIMESTAMP
       WHERE order_id = ? AND status = 'pending'`,
      [orderId],
      function(err) { callback(err, err ? null : { changes: this.changes }); }
    );
  },

  // An order that failed or was rejected must never pay out. Reversing is
  // only possible from 'pending' — a credited earning stays on the ledger.
  reverseReferralEarning: (orderId, callback) => {
    db.run(
      `UPDATE referral_earnings SET status = 'reversed'
       WHERE order_id = ? AND status = 'pending'`,
      [orderId],
      function(err) { callback(err, err ? null : { changes: this.changes }); }
    );
  },

  getReferralEarningByOrderId: (orderId, callback) => {
    db.get(`SELECT * FROM referral_earnings WHERE order_id = ?`, [orderId], callback);
  },

  // Everything a creator's dashboard needs, computed from the ledger rather
  // than from a running total that could drift.
  getReferralStats: (referralCodeId, callback) => {
    const sql = `SELECT
        (SELECT COUNT(*) FROM referral_attributions WHERE referral_code_id = ?) AS referred_users,
        (SELECT COUNT(*) FROM referral_earnings WHERE referral_code_id = ? AND status = 'credited') AS completed_orders,
        (SELECT COUNT(*) FROM referral_earnings WHERE referral_code_id = ? AND status = 'pending') AS pending_orders,
        (SELECT COALESCE(SUM(commission_robux), 0) FROM referral_earnings
          WHERE referral_code_id = ? AND status = 'credited') AS earned_robux,
        (SELECT COALESCE(SUM(commission_robux), 0) FROM referral_earnings
          WHERE referral_code_id = ? AND status = 'pending') AS pending_robux,
        (SELECT COALESCE(SUM(order_robux), 0) FROM referral_earnings
          WHERE referral_code_id = ? AND status = 'credited') AS driven_robux,
        (SELECT COALESCE(SUM(robux_amount), 0) FROM referral_payouts
          WHERE referral_code_id = ?) AS paid_out_robux`;
    const id = referralCodeId;
    db.get(sql, [id, id, id, id, id, id, id], (err, row) => {
      if (err) return callback(err, null);
      callback(null, {
        referredUsers: Number(row.referred_users),
        completedOrders: Number(row.completed_orders),
        pendingOrders: Number(row.pending_orders),
        earnedRobux: Number(row.earned_robux),
        pendingRobux: Number(row.pending_robux),
        drivenRobux: Number(row.driven_robux),
        paidOutRobux: Number(row.paid_out_robux),
        // Only credited earnings are payable — pending ones are orders that
        // haven't actually been delivered yet.
        balanceRobux: Number(row.earned_robux) - Number(row.paid_out_robux)
      });
    });
  },

  // Admin overview. Sorted by what each code has actually delivered, so the
  // creators worth talking to are at the top.
  getAllReferralCodes: (callback) => {
    const sql = `SELECT rc.*, u.username AS owner_username, u.roblox_id AS owner_roblox_id,
        (SELECT COUNT(*) FROM referral_attributions WHERE referral_code_id = rc.id) AS referred_users,
        (SELECT COUNT(*) FROM referral_earnings WHERE referral_code_id = rc.id AND status = 'credited') AS completed_orders,
        (SELECT COALESCE(SUM(commission_robux), 0) FROM referral_earnings
          WHERE referral_code_id = rc.id AND status = 'credited') AS earned_robux,
        (SELECT COALESCE(SUM(order_robux), 0) FROM referral_earnings
          WHERE referral_code_id = rc.id AND status = 'credited') AS driven_robux,
        (SELECT COALESCE(SUM(robux_amount), 0) FROM referral_payouts
          WHERE referral_code_id = rc.id) AS paid_out_robux
      FROM referral_codes rc
      JOIN users u ON u.id = rc.user_id
      ORDER BY driven_robux DESC, rc.created_at DESC`;
    db.all(sql, [], callback);
  },

  createReferralPayout: (referralCodeId, referrerUserId, robuxAmount, note, adminId, callback) => {
    db.run(
      `INSERT INTO referral_payouts (referral_code_id, referrer_user_id, robux_amount, note, admin_id)
       VALUES (?, ?, ?, ?, ?)`,
      [referralCodeId, referrerUserId, robuxAmount, note, adminId],
      function(err) { callback(err, err ? null : { id: this.lastID }); }
    );
  },

  getReferralPayouts: (referralCodeId, callback) => {
    db.all(
      `SELECT * FROM referral_payouts WHERE referral_code_id = ? ORDER BY created_at DESC`,
      [referralCodeId],
      callback
    );
  },
});
