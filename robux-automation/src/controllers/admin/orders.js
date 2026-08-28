// The order queue: reviewing payment, fulfilling, and resolving deliveries that stalled.
const RobloxGroup = require('../../services/roblox-group');
const { attemptGroupDelivery } = require('../../services/group-delivery');
const { ACTION, describeDeliveryFailure } = require('../../services/delivery-errors');
const { ORDER_STATUS } = require('../../services/order-status');
const { statusLabel } = require('../../services/order-status');
const orders = require('../../services/orders');
const { ACTIONS, recordAdminAction } = require('../../services/audit');

// The link an admin follows to buy the pass.
//
// It points at the experience, not at the pass. Both work, but they fail
// differently when the admin's browser is not signed in to roblox.com:
// /game-pass/<id> answers a bare 404 — true of any pass, including ones large
// games actively sell — while the experience page renders, so a stale session
// looks like a broken link in the first case and like a normal page in the
// second. Roblox redirects /games/<id> to the slugged URL on its own, so the
// bare id is enough.
//
// No #!/store fragment: that tab syntax is not in the page Roblox serves
// today. The admin lands on the experience and opens Store there.
//
// Rows with no universe recorded — only legacy orders, since every order the
// current code creates stores one — keep the per-pass URL. It is a poor link,
// but it carries the id, and there is nothing better to point them at.
function purchaseUrlFor(rootPlaceId, gamePassId) {
  return rootPlaceId
    ? `https://www.roblox.com/games/${rootPlaceId}`
    : `https://www.roblox.com/game-pass/${gamePassId}`;
}

// A date the client can express and Postgres can compare. Anything else —
// a half-typed box, a stray word, an attempt at SQL — becomes "no bound"
// rather than an error, because a filter is a question and a malformed one
// just means the admin is still typing.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(value) {
  const text = String(value || '').trim();
  return ISO_DATE.test(text) ? text : null;
}

// Long enough for a username or a reference code, short enough that nobody
// pastes a document into it. ILIKE on a huge string is a slow scan for a
// result that could never match anything.
const MAX_SEARCH = 64;
const PAGE_SIZE = 50;
const MAX_PAGE = 200;

function searchParam(value) {
  const text = String(value || '').trim().slice(0, MAX_SEARCH);
  return text ? text : null;
}

function pageParam(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 0), max);
}

module.exports = {
  async getOrders(req, res) {
    try {
      const orders = await new Promise((resolve, reject) => {
        this.dbHelpers.getGamePassOrders((error, rows) => {
          if (error) reject(error);
          else resolve(rows);
        });
      });

      // Resolved here rather than stored on the order: a root place is
      // derived data that Roblox owns, and one batched lookup per queue load
      // is cheaper than a column that can drift out of date.
      let rootPlaceIds = new Map();
      const universeIds = orders
        .filter((order) => order.delivery_method !== 'group' && order.universe_id)
        .map((order) => order.universe_id);

      if (universeIds.length) {
        try {
          rootPlaceIds = await this.RobloxAuth.getRootPlaceIds(universeIds);
        } catch (error) {
          // A Roblox outage must not empty the admin queue. Every row falls
          // back to the per-pass URL and the rest of the page still works.
          console.error('Root place lookup failed:', error.message);
        }
      }

      res.json({
        success: true,
        orders: orders.map((order) => ({
          ...order,
          purchaseUrl: order.delivery_method === 'group'
            ? null
            : purchaseUrlFor(rootPlaceIds.get(String(order.universe_id)), order.roblox_gamepass_id)
        }))
      });
    } catch (error) {
      console.error('Get purchase orders error:', error);
      res.status(500).json({ success: false, error: 'Захиалгын дарааллыг авч чадсангүй.' });
    }
  },

  // Sales totals for the dashboard. Read-only, and deliberately separate
  // from getOrders: the queue only carries what still needs working, while
  // these totals span every completed order back to the first one.
  //
  // Postgres returns COUNT and SUM over integers as bigint, which pg hands
  // back as strings — Number() here so the client never renders "12" + "3".
  async getOrderStats(req, res) {
    try {
      const row = await new Promise((resolve, reject) => {
        this.dbHelpers.getOrderStats((error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

      const period = (prefix) => ({
        orders: Number(row?.[`${prefix}_orders`] || 0),
        robux: Number(row?.[`${prefix}_robux`] || 0),
        mnt: Number(row?.[`${prefix}_mnt`] || 0)
      });

      res.json({
        success: true,
        stats: {
          today: period('today'),
          yesterday: period('yesterday'),
          week: period('week'),
          month: period('month'),
          lastMonth: period('last_month'),
          total: period('total')
        },
        // The dates each of those periods covers, resolved by Postgres in
        // Ulaanbaatar time. The dashboard's filter presets are set from
        // these rather than from the browser's clock, which belongs to
        // whatever machine the admin happens to be sitting at.
        periods: {
          today: { from: row?.today_date || null, to: row?.today_date || null },
          yesterday: { from: row?.yesterday_date || null, to: row?.yesterday_date || null },
          week: { from: row?.week_start || null, to: row?.today_date || null },
          month: { from: row?.month_start || null, to: row?.today_date || null },
          lastMonth: { from: row?.last_month_start || null, to: row?.last_month_end || null },
          total: { from: null, to: null }
        }
      });
    } catch (error) {
      console.error('Get order stats error:', error);
      res.status(500).json({ success: false, error: 'Борлуулалтын тоог авч чадсангүй.' });
    }
  },

  // Completed sales, filtered. Totals and rows come from the same source in
  // the repository, so the figure at the top always describes the list below
  // it — including the orders past the end of the page.
  //
  // One more row than asked for is fetched, purely to answer "is there
  // another page?" without a second COUNT over the same filter.
  async getSalesSearch(req, res) {
    const filters = {
      from: dateParam(req.query.from),
      to: dateParam(req.query.to),
      search: searchParam(req.query.search)
    };
    const limit = pageParam(req.query.limit, PAGE_SIZE, MAX_PAGE) || PAGE_SIZE;
    const offset = pageParam(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    try {
      const [totals, rows] = await Promise.all([
        new Promise((resolve, reject) => {
          this.dbHelpers.getSalesTotals(filters, (error, row) => (error ? reject(error) : resolve(row)));
        }),
        new Promise((resolve, reject) => {
          this.dbHelpers.searchSales(filters, limit + 1, offset, (error, result) => (
            error ? reject(error) : resolve(result)
          ));
        })
      ]);

      const page = rows.slice(0, limit);

      res.json({
        success: true,
        filters,
        totals: {
          orders: Number(totals?.orders || 0),
          robux: Number(totals?.robux || 0),
          mnt: Number(totals?.mnt || 0)
        },
        hasMore: rows.length > limit,
        sales: page.map((row) => ({
          id: Number(row.id),
          username: row.username,
          robloxId: String(row.roblox_id),
          paymentReference: row.payment_reference,
          deliveryMethod: row.delivery_method,
          robux: Number(row.robux),
          mnt: Number(row.mnt),
          completedAt: row.completed_at
        }))
      });
    } catch (error) {
      console.error('Sales search error:', error);
      res.status(500).json({ success: false, error: 'Борлуулалтыг хайж чадсангүй.' });
    }
  },

  async markOrderPurchased(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }
      if (order.status !== ORDER_STATUS.FULFILLMENT_PENDING) {
        return res.status(409).json({
          success: false,
          error: `Захиалга авахад бэлэн төлөвт биш байна (одоо: ${statusLabel(order.status)}).`
        });
      }

      if (order.delivery_method === 'group') {
        return this.checkGroupDelivery(req, res);
      }

      // Same lock the group route uses: claim the order before the
      // verification call so two admins clicking at once can't both complete
      // it. Verification is read-only, so a failure here safely releases.
      const claimed = await orders.claimForFulfillment(this.dbHelpers, orderId);
      if (!claimed) {
        return res.status(409).json({
          success: false,
          error: 'Энэ захиалгыг өөр админ боловсруулж байна.'
        });
      }

      let verification;
      try {
        verification = await this.RobloxAuth.verifySellerOwnsGamePass(order.roblox_gamepass_id);
      } catch (verifyError) {
        await orders.releaseFulfillmentClaim(this.dbHelpers, orderId, verifyError.message);
        throw verifyError;
      }

      // Not owning it yet is the ordinary case rather than a failure. Buying
      // the pass used to be a manual step — an admin opening its page and
      // clicking through — which turns out to be a step nobody could take:
      // Roblox serves a pass page only to the account that created it, so the
      // seller sees 404 no matter what. The purchase never needed that page.
      // The bot buys it here through the same call the Roblox client makes for
      // an in-experience purchase prompt.
      let purchase = null;
      if (!verification.owned) {
        try {
          purchase = await this.purchaseGamePassForOrder(order);
        } catch (purchaseError) {
          await orders.releaseFulfillmentClaim(this.dbHelpers, orderId, purchaseError.message);
          console.error('Game pass purchase failed:', purchaseError.response?.data || purchaseError.message);
          return res.status(purchaseError.preflight ? 409 : 502).json({
            success: false,
            error: purchaseError.message
          });
        }

        // Ownership stays the thing that completes an order. Roblox accepting
        // the charge is a claim about a payment; the inventory is the delivery.
        // Closing the order on the first without the second would mark Robux
        // delivered on the strength of a promise.
        verification = await this.RobloxAuth.verifySellerOwnsGamePass(order.roblox_gamepass_id);
        if (!verification.owned) {
          await orders.releaseFulfillmentClaim(
            this.dbHelpers, orderId, 'Purchase succeeded but the pass is not in the inventory.'
          );
          return res.status(502).json({
            success: false,
            error: 'Худалдан авалт амжилттай гэж хариулсан ч Roblox inventory дээр харагдахгүй байна. Түр хүлээгээд дахин шалгана уу.'
          });
        }
      }

      await orders.markCompleted(this.dbHelpers, orderId);

      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_FULFILLED, {
        entityType: 'order',
        entityId: orderId,
        details: {
          route: 'gamepass',
          gamePassId: order.roblox_gamepass_id,
          deliveredRobux: order.delivered_robux || order.price,
          verifiedVia: 'inventory_api',
          sellerUserId: verification.sellerUserId,
          // Whether this run spent Robux, and what Roblox charged for it.
          purchasedNow: Boolean(purchase),
          robuxSpent: purchase ? Number(order.listed_price) : 0
        }
      });

      res.json({
        success: true,
        message: purchase
          ? 'Game Pass-ийг bot аккаунтаар худалдаж авлаа. Захиалга дууссан.'
          : 'Roblox inventory баталгаажлаа. Захиалга дууссан.',
        sellerUserId: verification.sellerUserId,
        purchasedNow: Boolean(purchase)
      });
    } catch (error) {
      if (error.code !== 'ROBLOX_INVENTORY_NOT_CONFIGURED') {
        console.error('Verify purchase order error:', error.response?.data || error);
      }
      res.status(error.code === 'ROBLOX_INVENTORY_NOT_CONFIGURED' ? 503 : 502).json({
        success: false,
        error: error.code === 'ROBLOX_INVENTORY_NOT_CONFIGURED'
          ? error.message
          : 'Roblox inventory шалгаж чадсангүй. Дахин оролдоно уу.'
      });
    }
  },

  // Buys the pass this order is waiting on, with the seller bot's credential.
  //
  // Every guard here answers the same question: is the bot about to spend its
  // Robux on exactly the listing this order was priced against? The pass has
  // to belong to the buyer named on the order, and it has to still cost what
  // the order recorded — otherwise a buyer could raise their pass price after
  // ordering, or a tampered row could aim the bot's balance at any creator on
  // Roblox. Roblox re-checks both server-side from the values sent with the
  // charge; these checks exist so a mismatch is refused here, with a message
  // that says which fact moved.
  async purchaseGamePassForOrder(order) {
    const bot = await new Promise((resolve, reject) => {
      this.dbHelpers.getActiveSellerBot((error, row) => (error ? reject(error) : resolve(row)));
    });
    if (!bot?.cookie) {
      throw Object.assign(
        new Error('Seller bot аккаунт тохируулагдаагүй тул худалдан авалт хийх боломжгүй.'),
        { preflight: true }
      );
    }

    const withUser = await orders.getOrderWithUser(this.dbHelpers, order.id);
    const product = await this.RobloxAuth.getGamePassProductInfo(order.roblox_gamepass_id);

    if (!product.isForSale) {
      throw Object.assign(
        new Error('Энэ Game Pass одоогоор худалдаанд байхгүй байна.'),
        { preflight: true }
      );
    }
    if (product.sellerId !== Number(withUser?.roblox_id)) {
      throw Object.assign(
        new Error('Game Pass захиалагчийн Roblox аккаунтынх биш байна.'),
        { preflight: true }
      );
    }
    if (product.priceInRobux !== Number(order.listed_price)) {
      throw Object.assign(
        new Error(
          `Game Pass-ийн үнэ өөрчлөгдсөн байна (Roblox: ${product.priceInRobux} Robux, захиалга: ${order.listed_price} Robux).`
        ),
        { preflight: true }
      );
    }

    return RobloxGroup.buyGamePass({
      productId: product.productId,
      expectedPrice: product.priceInRobux,
      expectedSellerId: product.sellerId,
      cookie: bot.cookie,
      totpSecret: bot.totp_secret
    });
  },

  async markOrderPaymentReceived(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    try {
      // Approval and readiness-to-deliver are two distinct states, so an
      // approved order is durably recorded as approved even if resolving the
      // fulfillment route below fails.
      const approved = await orders.markPaymentApproved(this.dbHelpers, orderId, req.session?.adminId);
      if (!approved) {
        return res.status(409).json({
          success: false,
          error: 'Шалгагдахаар хүлээж буй захиалга олдсонгүй. Хэрэглэгч баримтаа илгээсэн эсэхийг шалгана уу.'
        });
      }
      await orders.markFulfillmentPending(this.dbHelpers, orderId);

      const order = await orders.getOrder(this.dbHelpers, orderId);

      // The single most important line in the log: a human decided this
      // payment was real, and everything downstream follows from it.
      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_PAYMENT_APPROVED, {
        entityType: 'order',
        entityId: orderId,
        details: {
          amountMnt: order?.amount_mnt,
          paymentReference: order?.payment_reference,
          deliveryMethod: order?.delivery_method
        }
      });

      if (order?.delivery_method === 'group') {
        // Try right away in case the buyer already sent their join request;
        // the background poller will keep retrying otherwise.
        try {
          const outcome = await attemptGroupDelivery(this.dbHelpers, orderId);
          const waiting = outcome.reason === 'membership_too_new' && outcome.eligibility
            ? `Төлбөрийг баталгаажууллаа. Хэрэглэгчийн группын гишүүнчлэл ${outcome.eligibility.daysRemaining} хоногийн дараа болно.`
            : 'Төлбөрийг баталгаажууллаа. Хэрэглэгч группд нэгдэх хүсэлт илгээхийг хүлээж байна.';
          return res.json({
            success: true,
            message: outcome.delivered
              ? 'Төлбөр баталгаажлаа. Групп payout шууд илгээгдлээ.'
              : waiting
          });
        } catch (deliveryError) {
          console.error('Immediate group delivery error:', deliveryError.response?.data || deliveryError);
          return res.json({
            success: true,
            message: 'Төлбөрийг баталгаажууллаа. Групп автоматжуулалт тохируулагдмагц ажиллана.'
          });
        }
      }

      res.json({ success: true, message: 'Төлбөрийг баталгаажууллаа. Game Pass авахад бэлэн.' });
    } catch (error) {
      console.error('Mark order payment error:', error);
      res.status(500).json({ success: false, error: 'Төлбөрийн төлөв шинэчлэгдсэнгүй.' });
    }
  },

  // Marks that an admin has opened this receipt. Advisory: approve and reject
  // both accept PAYMENT_SUBMITTED as well, so two admins working the queue at
  // once never deadlock each other — this just makes the queue readable.
  async markOrderUnderReview(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    try {
      const moved = await orders.markUnderReview(this.dbHelpers, orderId, req.session?.adminId);
      if (!moved) {
        return res.status(409).json({
          success: false,
          error: 'Энэ захиалга шалгах хүлээлгийн төлөвт биш байна.'
        });
      }
      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_UNDER_REVIEW, {
        entityType: 'order',
        entityId: orderId
      });

      res.json({ success: true, message: 'Захиалгыг шалгаж эхэллээ.' });
    } catch (error) {
      console.error('Mark order under review error:', error);
      res.status(500).json({ success: false, error: 'Захиалгын төлөв шинэчлэгдсэнгүй.' });
    }
  },

  // Rejects a submitted payment with a reason the buyer will see. This is not
  // terminal: the order drops back to a state where a corrected receipt can be
  // uploaded against it, so a blurry photo doesn't force a whole new order
  // (and a whole new reference code) on the buyer.
  async rejectOrderPayment(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    const reason = String(req.body.reason || '').trim();
    if (reason.length < 4 || reason.length > 300) {
      return res.status(400).json({
        success: false,
        error: 'Татгалзсан шалтгааныг 4-300 тэмдэгтээр бичнэ үү.'
      });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }

      const moved = await orders.markPaymentRejected(
        this.dbHelpers, orderId, req.session?.adminId, reason
      );
      if (!moved) {
        return res.status(409).json({
          success: false,
          error: `Энэ захиалгыг татгалзах боломжгүй (одоо: ${statusLabel(order.status)}).`
        });
      }

      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_PAYMENT_REJECTED, {
        entityType: 'order',
        entityId: orderId,
        details: {
          reason,
          amountMnt: order.amount_mnt,
          paymentReference: order.payment_reference
        }
      });

      res.json({
        success: true,
        message: 'Төлбөрийг татгалзлаа. Хэрэглэгч шинэ баримт илгээх боломжтой.'
      });
    } catch (error) {
      console.error('Reject order payment error:', error);
      res.status(500).json({ success: false, error: 'Татгалзах үйлдэл амжилтгүй боллоо.' });
    }
  },

  // GET /admin/orders/stalled — orders stuck mid-delivery.
  //
  // These are the only orders the system will not resolve on its own. Each
  // one had a payout request issued that we never saw a result for, so the
  // question "did the Robux actually arrive?" can only be answered by looking
  // at the group's payout history on Roblox.
  async getStalledOrders(req, res) {
    try {
      const stalled = await new Promise((resolve, reject) => {
        this.dbHelpers.getStalledFulfillments(1, (error, rows) => (error ? reject(error) : resolve(rows)));
      });

      // Rather than sending the admin off to Roblox to read the payout
      // history by hand, read it here and match each stalled order against
      // it. One API call for the whole queue, and the answer arrives in the
      // same view as the buttons that act on it.
      //
      // This is evidence, not a decision: robloxSaysDelivered is surfaced to
      // inform the admin's choice, and resolveStalledOrder still requires
      // them to state an outcome explicitly. Auto-resolving on a ledger match
      // would put a double payout one API quirk away.
      let ledger = null;
      if (stalled.some((order) => order.delivery_method === 'group')) {
        const [groupId, bot] = await Promise.all([
          this.getSettingValue('group_id'),
          new Promise((resolve, reject) => {
            this.dbHelpers.getActiveSellerBot((error, row) => (error ? reject(error) : resolve(row)));
          })
        ]);
        if (groupId && bot?.cookie) {
          ledger = await RobloxGroup.getRecentPayouts(groupId, bot.cookie);
        }
      }

      res.json({
        success: true,
        // Tells the dashboard whether to trust the per-order verdicts below
        // or tell the admin to go and look for themselves.
        payoutHistoryAvailable: ledger !== null,
        orders: stalled.map((order) => {
          const amountRobux = order.delivered_robux || order.price;
          return {
            id: order.id,
            username: order.username,
            robloxId: order.roblox_id,
            deliveryMethod: order.delivery_method,
            amountRobux,
            amountMnt: order.amount_mnt,
            paymentReference: order.payment_reference,
            startedAt: order.fulfillment_started_at,
            error: order.fulfillment_error,
            // true = Roblox's ledger shows it; false = it does not;
            // null = we could not read the ledger, so decide by hand.
            robloxSaysDelivered: order.delivery_method === 'group'
              ? RobloxGroup.matchPayout(ledger, order.roblox_id, amountRobux)
              : null
          };
        })
      });
    } catch (error) {
      console.error('Get stalled orders error:', error);
      res.status(500).json({ success: false, error: 'Гацсан захиалгуудыг авч чадсангүй.' });
    }
  },

  // Resolves a stuck order once an admin has checked Roblox and knows what
  // actually happened. Requires an explicit outcome — there is deliberately
  // no "just try again" button, because retrying a payout that already landed
  // is the exact failure this whole mechanism exists to prevent.
  //
  //   outcome=delivered — the payout is visible on Roblox; close as completed.
  //   outcome=not_delivered — nothing arrived; return the order to the queue
  //                           so the poller can legitimately retry it.
  //   outcome=failed — give up and mark it failed for manual refund.
  async resolveStalledOrder(req, res) {
    const orderId = Number(req.params.id);
    const outcome = String(req.body.outcome || '');
    const note = String(req.body.note || '').trim().slice(0, 300);

    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }
    if (!['delivered', 'not_delivered', 'failed'].includes(outcome)) {
      return res.status(400).json({
        success: false,
        error: 'Roblox дээрх бодит үр дүнг сонгоно уу (хүргэгдсэн / хүргэгдээгүй / амжилтгүй).'
      });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }
      if (order.status !== ORDER_STATUS.FULFILLMENT_PROCESSING) {
        return res.status(409).json({
          success: false,
          error: `Энэ захиалга гацаагүй байна (одоо: ${statusLabel(order.status)}).`
        });
      }

      let moved;
      let message;
      if (outcome === 'delivered') {
        moved = await orders.markCompleted(this.dbHelpers, orderId);
        message = 'Захиалгыг хүргэгдсэн гэж бүртгэлээ.';
      } else if (outcome === 'not_delivered') {
        moved = await orders.releaseFulfillmentClaim(this.dbHelpers, orderId, note || null);
        message = 'Захиалгыг дараалалд буцаалаа. Автоматаар дахин оролдоно.';
      } else {
        moved = await orders.markFailed(this.dbHelpers, orderId, note || 'Админ амжилтгүй гэж бүртгэв.');
        message = 'Захиалгыг амжилтгүй гэж бүртгэлээ. Төлбөрийг буцаана уу.';
      }

      if (!moved) {
        return res.status(409).json({ success: false, error: 'Захиалгын төлөв өөрчлөгдсөн байна.' });
      }

      // The admin's stated finding is the justification for whatever happens
      // to this order next, so it's recorded verbatim.
      await recordAdminAction(
        this.dbHelpers,
        req,
        outcome === 'failed' ? ACTIONS.ORDER_MARKED_FAILED : ACTIONS.ORDER_FULFILLED,
        {
          entityType: 'order',
          entityId: orderId,
          details: {
            resolution: outcome,
            note: note || null,
            manualResolution: true,
            previousError: order.fulfillment_error
          }
        }
      );

      res.json({ success: true, message });
    } catch (error) {
      console.error('Resolve stalled order error:', error);
      res.status(500).json({ success: false, error: 'Захиалгыг шийдвэрлэж чадсангүй.' });
    }
  },

  async checkGroupDelivery(req, res) {
    const orderId = Number(req.params.id);
    try {
      const outcome = await attemptGroupDelivery(this.dbHelpers, orderId);
      if (!outcome.delivered) {
        // "Not yet" is the expected answer for most of a group order's life —
        // say which wait it's in, since they resolve very differently.
        const messages = {
          awaiting_join: 'Хэрэглэгч группд нэгдэх хүсэлт хараахан илгээгээгүй байна.',
          membership_too_new: outcome.eligibility
            ? `Хэрэглэгч группд элссэн боловч ${outcome.eligibility.requiredDays} хоног болоогүй байна. Үлдсэн: ${outcome.eligibility.daysRemaining} хоног.`
            : 'Хэрэглэгчийн группын гишүүнчлэл хараахан болоогүй байна.',
          already_processing: 'Энэ захиалгыг өөр процесс боловсруулж байна.'
        };
        return res.status(409).json({
          success: false,
          error: messages[outcome.reason] || 'Хүргэлт хараахан боломжгүй байна.',
          reason: outcome.reason,
          eligibility: outcome.eligibility || null
        });
      }
      res.json({ success: true, message: 'Группын payout илгээгдлээ. Захиалга дууссан.' });
    } catch (error) {
      const failure = describeDeliveryFailure(error);

      // Only the unexplained ones are worth a stack in the log; the rest are
      // fully described by what the admin is about to be shown.
      if (failure.action === ACTION.RETRY && !error.response) {
        console.error('Group delivery error:', error);
      } else {
        console.error(`Group delivery order #${orderId} [${failure.action}]:`, failure.message);
      }

      res.status(failure.httpStatus).json({
        success: false,
        error: failure.message,
        code: failure.code,
        // 'resolve' means a payout may already have landed. The dashboard
        // must not offer a retry button on one of these.
        action: failure.action
      });
    }
  }
};
