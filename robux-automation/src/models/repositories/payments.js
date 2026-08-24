const { isUniqueViolation } = require('../db-errors');
// Gateway confirmations. The UNIQUE index behind claimPayment is what makes a
// replayed webhook harmless.
module.exports = (db) => ({
  // Claims a provider transaction id. Winning the INSERT is what grants the
  // right to approve an order; losing it means this confirmation has already
  // been handled and the caller must stop rather than approve again.
  //
  // Deliberately shaped like claimForFulfillment: claim first, act second.
  claimPayment: (payment, callback) => {
    const sql = `INSERT INTO payments
      (provider, provider_payment_id, payment_reference, amount_mnt, entity_type, entity_id, outcome, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [
      payment.provider,
      payment.providerPaymentId,
      payment.paymentReference || null,
      payment.amountMnt ?? null,
      payment.entityType || null,
      payment.entityId ?? null,
      payment.outcome,
      payment.reason || null
    ], function(err) {
      if (err) {
        // A duplicate is the expected, healthy outcome of a retried webhook —
        // reported rather than thrown so callers can no-op quietly.
        if (isUniqueViolation(err)) {
          return callback(null, { duplicate: true });
        }
        return callback(err, null);
      }
      callback(null, { duplicate: false, id: this.lastID });
    });
  },

  // Records what became of a claimed payment once the order was actually
  // moved (or refused). The claim row already exists; this fills in the verdict.
  updatePaymentOutcome: (id, outcome, reason, callback) => {
    db.run(
      `UPDATE payments SET outcome = ?, reason = ? WHERE id = ?`,
      [outcome, reason || null, id],
      function(err) { callback(err, err ? null : { changes: this.changes }); }
    );
  },

  getPayments: (limit, callback) => {
    db.all(
      `SELECT * FROM payments ORDER BY created_at DESC, id DESC LIMIT ?`,
      [Number(limit) || 100],
      callback
    );
  },

  // Finds whatever a payment reference belongs to. Checked across both tables
  // because an order and a gift card draw from the same reference namespace.
  findByPaymentReference: (reference, callback) => {
    db.get(
      `SELECT id, user_id AS owner_id, amount_mnt, status, 'order' AS entity_type
         FROM game_passes WHERE payment_reference = ?
       UNION ALL
       SELECT id, purchaser_user_id AS owner_id, price_mnt AS amount_mnt, status, 'gift_card' AS entity_type
         FROM gift_cards WHERE payment_reference = ?`,
      [reference, reference],
      callback
    );
  },
});
