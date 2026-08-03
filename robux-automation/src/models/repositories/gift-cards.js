// Purchase, approval and single-use redemption. claimGiftCardForRedemption is the
// guard that stops one code being spent twice.
module.exports = (db) => ({
  createGiftCard: (code, robuxAmount, priceMnt, paymentReference, purchaserUserId, callback) => {
    const sql = `INSERT INTO gift_cards (code, robux_amount, price_mnt, payment_reference, purchaser_user_id) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [code, robuxAmount, priceMnt, paymentReference, purchaserUserId], function(err) {
      callback(err, err ? null : { id: this.lastID, code, robuxAmount, priceMnt, paymentReference, purchaserUserId, status: 'awaiting_payment' });
    });
  },

  getGiftCardByCode: (code, callback) => {
    db.get(`SELECT * FROM gift_cards WHERE code = ?`, [code], callback);
  },

  getGiftCardById: (id, callback) => {
    db.get(`SELECT * FROM gift_cards WHERE id = ?`, [id], callback);
  },

  // A buyer's own gift cards — so they can come back and find the code
  // once admin has approved it.
  getGiftCardsByPurchaser: (userId, callback) => {
    db.all(`SELECT * FROM gift_cards WHERE purchaser_user_id = ? ORDER BY created_at DESC`, [userId], callback);
  },

  // Admin-only listing, newest first, joined to the purchaser's username.
  getGiftCards: (callback) => {
    const sql = `SELECT g.*, u.username AS purchaser_username, u.roblox_id AS purchaser_roblox_id,
        r.id AS receipt_id, r.mime_type AS receipt_mime, r.uploaded_at AS receipt_uploaded_at
      FROM gift_cards g
      JOIN users u ON u.id = g.purchaser_user_id
      LEFT JOIN receipts r ON r.id = (
        SELECT id FROM receipts
        WHERE entity_type = 'gift_card' AND entity_id = g.id
        ORDER BY uploaded_at DESC, id DESC LIMIT 1
      )
      ORDER BY g.created_at DESC`;
    db.all(sql, [], callback);
  },

  markGiftCardPaymentReceived: (id, callback) => {
    const sql = `UPDATE gift_cards SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'awaiting_payment'`;
    db.run(sql, [id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  // Sends the card back to awaiting_payment with a reason, so the buyer can
  // upload a corrected receipt against the same card and code.
  rejectGiftCardPayment: (id, reason, callback) => {
    const sql = `UPDATE gift_cards SET status = 'awaiting_payment', rejection_reason = ?
      WHERE id = ? AND status = 'awaiting_payment'`;
    db.run(sql, [reason, id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  // The redemption lock, and the same shape as transitionOrderStatus: the
  // WHERE clause is the guard, and `changes` is the answer to "did I win?".
  //
  // A gift card code is meant to be handed around, so two people redeeming it
  // at the same moment is a completely ordinary thing to happen rather than a
  // freak race. Winning this UPDATE is what grants the right to create a
  // delivery order; the caller must not proceed on changes === 0.
  //
  // redeemed_order_id is filled in afterwards by attachGiftCardOrder, because
  // the claim has to be taken before the order exists — the other ordering
  // leaves a window where two orders are already created and only one of them
  // can legitimately be paid.
  claimGiftCardForRedemption: (id, redeemedByUserId, callback) => {
    const sql = `UPDATE gift_cards
      SET status = 'redeemed', redeemed_by_user_id = ?, redeemed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'approved'`;
    db.run(sql, [redeemedByUserId, id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  attachGiftCardOrder: (id, redeemedOrderId, callback) => {
    const sql = `UPDATE gift_cards SET redeemed_order_id = ? WHERE id = ? AND status = 'redeemed'`;
    db.run(sql, [redeemedOrderId, id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  // Undoes a claim whose delivery order could never be created. Only safe
  // while redeemed_order_id is still NULL — once an order exists the card has
  // genuinely been spent.
  releaseGiftCardClaim: (id, callback) => {
    const sql = `UPDATE gift_cards
      SET status = 'approved', redeemed_by_user_id = NULL, redeemed_at = NULL
      WHERE id = ? AND status = 'redeemed' AND redeemed_order_id IS NULL`;
    db.run(sql, [id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },
});
