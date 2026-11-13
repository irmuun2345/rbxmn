// Orders, in both delivery flavours. transitionOrderStatus is the primitive every
// status change goes through — its WHERE clause is what makes concurrent callers safe.
const {
  ORDER_STATUS,
  ACTIVE_STATUSES,
  ADMIN_QUEUE_STATUSES,
  placeholders
} = require('../../services/order-status');

// One completed order per row, with the local day it landed on already
// worked out. Both filtered sales views read from this, so a row can never be
// counted in the totals but missing from the list under them.
const SALES_SOURCE = `WITH sales AS (
    SELECT
      gp.id,
      u.username,
      u.roblox_id,
      gp.payment_reference,
      gp.delivery_method,
      COALESCE(gp.delivered_robux, gp.price, 0) AS robux,
      COALESCE(gp.amount_mnt, 0) AS mnt,
      COALESCE(gp.completed_at, gp.created_at) AS completed_at,
      (COALESCE(gp.completed_at, gp.created_at) AT TIME ZONE 'Asia/Ulaanbaatar')::date AS day
    FROM game_passes gp
    JOIN users u ON u.id = gp.user_id
    WHERE gp.status = ?
  )`;

// Every filter is optional and each one is its own NULL check, so an admin can
// search without a date range, bound a range without searching, or ask for
// everything. The casts are not decoration: a bare parameter compared against
// NULL leaves Postgres with no type to infer and the statement fails to parse.
//
// A reference is typed off a bank statement and a username is remembered
// rather than copied, so both match case-insensitively on a substring. The
// Roblox id is matched whole — it is a number an admin pastes, and '123' as a
// substring would drag in every account that merely contains it.
const SALES_FILTER = `WHERE (?::date IS NULL OR day >= ?::date)
    AND (?::date IS NULL OR day <= ?::date)
    AND (?::text IS NULL
      OR username ILIKE ?
      OR payment_reference ILIKE ?
      OR roblox_id::text = ?)`;

function salesFilterParams({ from = null, to = null, search = null }) {
  const like = search === null ? null : `%${search}%`;
  return [from, from, to, to, search, like, like, search];
}

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

  // An order an admin delivers by hand after the buyer messages us on
  // Messenger. Same columns as a group order; only the method differs.
  createManualOrder: (userId, desiredRobux, amountMnt, ratePer100Mnt, paymentReference, deliveredRobux, bonusPercent, callback) => {
    const sql = `INSERT INTO game_passes
      (user_id, name, description, price, listed_price, amount_mnt, rate_per_100_mnt,
       payment_reference, delivered_robux, bonus_percent, delivery_method, status)
      VALUES (?, 'Manual delivery', 'Robux delivered by hand via Messenger', ?, ?, ?, ?, ?, ?, ?, 'manual', '${ORDER_STATUS.AWAITING_PAYMENT}')`;
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
          deliveryMethod: 'manual',
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

  // Sales totals for the dashboard, cut by period.
  //
  // Only completed orders count: anything earlier is a promise, not a sale,
  // and counting it would have the strip drop back down whenever a payment
  // is rejected. Gift cards are a separate ledger and are not in here.
  //
  // The day boundary is Ulaanbaatar local, not UTC. Postgres stores every
  // timestamp in UTC, so a naive ::date puts the eight hours after midnight
  // local — a busy part of the evening here — on the previous day, and
  // "today" would be wrong for a third of the working day.
  //
  // `delivered_robux` is the amount actually paid out (bonus included), and
  // `price` is the fallback for rows created before that column existed.
  getOrderStats: (callback) => {
    const sql = `WITH bounds AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Ulaanbaatar')::date AS today
      ),
      sales AS (
        SELECT
          COALESCE(delivered_robux, price, 0) AS robux,
          COALESCE(amount_mnt, 0) AS mnt,
          (COALESCE(completed_at, created_at) AT TIME ZONE 'Asia/Ulaanbaatar')::date AS day
        FROM game_passes
        WHERE status = ?
      )
      SELECT
        COUNT(s.day) FILTER (WHERE s.day = b.today) AS today_orders,
        COALESCE(SUM(s.robux) FILTER (WHERE s.day = b.today), 0) AS today_robux,
        COALESCE(SUM(s.mnt) FILTER (WHERE s.day = b.today), 0) AS today_mnt,

        COUNT(s.day) FILTER (WHERE s.day = b.today - 1) AS yesterday_orders,
        COALESCE(SUM(s.robux) FILTER (WHERE s.day = b.today - 1), 0) AS yesterday_robux,
        COALESCE(SUM(s.mnt) FILTER (WHERE s.day = b.today - 1), 0) AS yesterday_mnt,

        COUNT(s.day) FILTER (WHERE s.day > b.today - 7) AS week_orders,
        COALESCE(SUM(s.robux) FILTER (WHERE s.day > b.today - 7), 0) AS week_robux,
        COALESCE(SUM(s.mnt) FILTER (WHERE s.day > b.today - 7), 0) AS week_mnt,

        COUNT(s.day) FILTER (WHERE s.day >= date_trunc('month', b.today)) AS month_orders,
        COALESCE(SUM(s.robux) FILTER (WHERE s.day >= date_trunc('month', b.today)), 0) AS month_robux,
        COALESCE(SUM(s.mnt) FILTER (WHERE s.day >= date_trunc('month', b.today)), 0) AS month_mnt,

        COUNT(s.day) FILTER (WHERE date_trunc('month', s.day)
          = date_trunc('month', b.today) - INTERVAL '1 month') AS last_month_orders,
        COALESCE(SUM(s.robux) FILTER (WHERE date_trunc('month', s.day)
          = date_trunc('month', b.today) - INTERVAL '1 month'), 0) AS last_month_robux,
        COALESCE(SUM(s.mnt) FILTER (WHERE date_trunc('month', s.day)
          = date_trunc('month', b.today) - INTERVAL '1 month'), 0) AS last_month_mnt,

        COUNT(s.day) AS total_orders,
        COALESCE(SUM(s.robux), 0) AS total_robux,
        COALESCE(SUM(s.mnt), 0) AS total_mnt,

        to_char(b.today, 'YYYY-MM-DD') AS today_date,
        to_char(b.today - 1, 'YYYY-MM-DD') AS yesterday_date,
        to_char(b.today - 6, 'YYYY-MM-DD') AS week_start,
        to_char(date_trunc('month', b.today), 'YYYY-MM-DD') AS month_start,
        to_char(date_trunc('month', b.today) - INTERVAL '1 month', 'YYYY-MM-DD') AS last_month_start,
        to_char(date_trunc('month', b.today) - INTERVAL '1 day', 'YYYY-MM-DD') AS last_month_end
      FROM bounds b
      LEFT JOIN sales s ON TRUE
      GROUP BY b.today`;
    db.get(sql, [ORDER_STATUS.COMPLETED], callback);
  },

  // The totals for whatever the admin has filtered to. Counted by Postgres
  // rather than by adding up the page below it, so the figure stays right
  // when the list is capped at a page of results.
  getSalesTotals: (filters, callback) => {
    const sql = `${SALES_SOURCE}
      SELECT
        COUNT(*) AS orders,
        COALESCE(SUM(robux), 0) AS robux,
        COALESCE(SUM(mnt), 0) AS mnt
      FROM sales
      ${SALES_FILTER}`;
    db.get(sql, [ORDER_STATUS.COMPLETED, ...salesFilterParams(filters)], callback);
  },

  // The orders behind those totals, newest first. LIMIT is always set by the
  // caller: an install with a year of history would otherwise send every
  // order it has ever completed to the browser.
  searchSales: (filters, limit, offset, callback) => {
    const sql = `${SALES_SOURCE}
      SELECT id, username, roblox_id, payment_reference, delivery_method, robux, mnt, completed_at
      FROM sales
      ${SALES_FILTER}
      ORDER BY completed_at DESC, id DESC
      LIMIT ? OFFSET ?`;
    db.all(
      sql,
      [ORDER_STATUS.COMPLETED, ...salesFilterParams(filters), Number(limit), Number(offset)],
      callback
    );
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
