// Orders, in both delivery flavours. transitionOrderStatus is the primitive every
// status change goes through — its WHERE clause is what makes concurrent callers safe.
const {
  ORDER_STATUS,
  ACTIVE_STATUSES,
  ADMIN_QUEUE_STATUSES,
  placeholders
} = require('../../services/order-status');

module.exports = (db) => ({
  // Create a game pass
  createGamePass: (userId, name, description, price, robloxGamePassId, callback) => {
    const sql = `INSERT INTO game_passes (user_id, name, description, price, roblox_gamepass_id) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [userId, name, description, price, robloxGamePassId], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID, userId, name, description, price, robloxGamePassId });
      }
    });
  },

  createGamePassOrder: (
    userId,
    name,
    description,
    price,
    robloxGamePassId,
    universeId,
    listedPrice,
    amountMnt,
    ratePer100Mnt,
    paymentReference,
    deliveredRobux,
    bonusPercent,
    callback
  ) => {
    const sql = `INSERT INTO game_passes
      (user_id, name, description, price, roblox_gamepass_id, universe_id, listed_price,
       amount_mnt, rate_per_100_mnt, payment_reference, delivered_robux, bonus_percent, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${ORDER_STATUS.AWAITING_PAYMENT}')`;
    db.run(
      sql,
      [
        userId,
        name,
        description,
        price,
        robloxGamePassId,
        universeId,
        listedPrice,
        amountMnt,
        ratePer100Mnt,
        paymentReference,
        deliveredRobux,
        bonusPercent
      ],
      function(err) {
        callback(err, err ? null : {
          id: this.lastID,
          userId,
          name,
          description,
          price,
          robloxGamePassId,
          universeId,
          listedPrice,
          amountMnt,
          ratePer100Mnt,
          paymentReference,
          deliveredRobux,
          bonusPercent,
          status: ORDER_STATUS.AWAITING_PAYMENT
        });
      }
    );
  },

  createGroupOrder: (userId, desiredRobux, amountMnt, ratePer100Mnt, paymentReference, deliveredRobux, bonusPercent, callback) => {
    const sql = `INSERT INTO game_passes
      (user_id, name, description, price, listed_price, amount_mnt, rate_per_100_mnt,
       payment_reference, delivered_robux, bonus_percent, delivery_method, status)
      VALUES (?, 'Group payout', 'Robux delivered via group payout', ?, ?, ?, ?, ?, ?, ?, 'group', '${ORDER_STATUS.AWAITING_PAYMENT}')`;
    db.run(
      sql,
      [userId, desiredRobux, deliveredRobux, amountMnt, ratePer100Mnt, paymentReference, deliveredRobux, bonusPercent],
      function(err) {
        callback(err, err ? null : {
          id: this.lastID,
          userId,
          price: desiredRobux,
          amountMnt,
          ratePer100Mnt,
          paymentReference,
          deliveredRobux,
          bonusPercent,
          deliveryMethod: 'group',
          status: ORDER_STATUS.AWAITING_PAYMENT
        });
      }
    );
  },

  // Get game passes by user ID
  getGamePassesByUserId: (userId, callback) => {
    const sql = `SELECT * FROM game_passes WHERE user_id = ?`;
    db.all(sql, [userId], (err, rows) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, rows);
      }
    });
  },

  // Get game pass by ID
  getGamePassById: (id, callback) => {
    const sql = `SELECT * FROM game_passes WHERE id = ?`;
    db.get(sql, [id], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  getGamePassOrders: (callback) => {
    const sql = `SELECT gp.*, u.username, u.roblox_id,
        r.id AS receipt_id,
        r.original_name AS receipt_name,
        r.mime_type AS receipt_mime,
        r.uploaded_at AS receipt_uploaded_at,
        (SELECT COUNT(*) FROM receipts
          WHERE entity_type = 'order' AND entity_id = gp.id) AS receipt_count
      FROM game_passes gp
      JOIN users u ON u.id = gp.user_id
      LEFT JOIN receipts r ON r.id = (
        SELECT id FROM receipts
        WHERE entity_type = 'order' AND entity_id = gp.id
        ORDER BY uploaded_at DESC, id DESC LIMIT 1
      )
      WHERE gp.status != '${ORDER_STATUS.LEGACY}'
      ORDER BY gp.created_at DESC`;
    db.all(sql, [], callback);
  },

  // An order still in flight for this user, regardless of delivery method —
  // used to stop a second order (and a second real Game Pass / group
  // payout) from being created while one is already pending.
  getActiveOrderForUser: (userId, callback) => {
    const sql = `SELECT * FROM game_passes
      WHERE user_id = ? AND status IN (${placeholders(ACTIVE_STATUSES)})
      ORDER BY created_at DESC LIMIT 1`;
    db.get(sql, [userId, ...ACTIVE_STATUSES], callback);
  },

  // Group orders whose payment has cleared and which are waiting on delivery.
  // Deliberately excludes FULFILLMENT_PROCESSING: a row in that state has
  // already had a payout call issued against it, and re-entering the poller
  // is precisely how a buyer would get paid twice.
  getPendingGroupOrders: (callback) => {
    const sql = `SELECT id FROM game_passes
      WHERE delivery_method = 'group' AND status = ?`;
    db.all(sql, [ORDER_STATUS.FULFILLMENT_PENDING], callback);
  },

  // Orders that have been sitting mid-delivery for longer than the given
  // number of minutes — these need a human to check Roblox and decide.
  getStalledFulfillments: (olderThanMinutes, callback) => {
    const sql = `SELECT gp.*, u.username, u.roblox_id
      FROM game_passes gp
      JOIN users u ON u.id = gp.user_id
      WHERE gp.status = ?
        AND gp.fulfillment_started_at IS NOT NULL
        AND gp.fulfillment_started_at <= NOW() - (? * INTERVAL '1 minute')
      ORDER BY gp.fulfillment_started_at ASC`;
    db.all(sql, [ORDER_STATUS.FULFILLMENT_PROCESSING, Number(olderThanMinutes)], callback);
  },

  // Checked across both tables that hand out reference codes, so an order and
  // a gift card can never advertise the same one to two different buyers.
  isPaymentReferenceTaken: (reference, callback) => {
    const sql = `SELECT
        (SELECT COUNT(*) FROM game_passes WHERE payment_reference = ?)
      + (SELECT COUNT(*) FROM gift_cards WHERE payment_reference = ?) AS count`;
    db.get(sql, [reference, reference], (err, row) => {
      callback(err, err ? null : Number(row.count) > 0);
    });
  },

  getOrderWithUser: (id, callback) => {
    const sql = `SELECT gp.*, u.username, u.roblox_id
      FROM game_passes gp
      JOIN users u ON u.id = gp.user_id
      WHERE gp.id = ?`;
    db.get(sql, [id], callback);
  },

  // The one primitive every status change goes through. `fromStatuses` is the
  // guard: the UPDATE only matches a row that is still in an expected state,
  // so two concurrent callers racing on the same order produce one winner
  // (changes === 1) and one loser (changes === 0) instead of both proceeding.
  transitionOrderStatus: (id, fromStatuses, toStatus, extraColumns, callback) => {
    const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
    const assignments = ['status = ?'];
    const params = [toStatus];

    Object.entries(extraColumns || {}).forEach(([column, value]) => {
      assignments.push(`${column} = ?`);
      params.push(value);
    });

    const sql = `UPDATE game_passes SET ${assignments.join(', ')}
      WHERE id = ? AND status IN (${placeholders(from)})`;
    db.run(sql, [...params, id, ...from], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  // Admin queue counts, for the badge on each tab.
  getOrderStatusCounts: (callback) => {
    const sql = `SELECT status, COUNT(*) AS count FROM game_passes
      WHERE status IN (${placeholders(ADMIN_QUEUE_STATUSES)})
      GROUP BY status`;
    db.all(sql, ADMIN_QUEUE_STATUSES, (err, rows) => {
      if (err) return callback(err, null);
      const counts = {};
      ADMIN_QUEUE_STATUSES.forEach((status) => { counts[status] = 0; });
      rows.forEach((row) => { counts[row.status] = Number(row.count); });
      callback(null, counts);
    });
  },
});
