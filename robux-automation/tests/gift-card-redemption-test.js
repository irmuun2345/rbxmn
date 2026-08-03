const assert = require('assert');
const GiftCardController = require('../src/controllers/giftcard-controller');
const { computeLevel, parseThresholds } = require('../src/services/levels');
const { ORDER_STATUS } = require('../src/services/order-status');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

// A stub holding one approved gift card. claimGiftCardForRedemption applies
// the same guarded UPDATE the real schema does — that guard is the thing
// under test, so faking it away would test nothing.
function createStubDb() {
  const card = {
    id: 9,
    code: 'GIFT-ABCD2345',
    robux_amount: 800,
    price_mnt: 36000,
    purchaser_user_id: 3,
    status: 'approved',
    redeemed_by_user_id: null,
    redeemed_order_id: null
  };

  const state = { card, orders: [], nextOrderId: 100, audit: [] };

  return {
    state,
    getGiftCardByCode(code, callback) {
      callback(null, code === card.code ? { ...card } : null);
    },
    claimGiftCardForRedemption(id, userId, callback) {
      if (id !== card.id || card.status !== 'approved') {
        return callback(null, { changes: 0 });
      }
      card.status = 'redeemed';
      card.redeemed_by_user_id = userId;
      callback(null, { changes: 1 });
    },
    attachGiftCardOrder(id, orderId, callback) {
      if (card.status !== 'redeemed') return callback(null, { changes: 0 });
      card.redeemed_order_id = orderId;
      callback(null, { changes: 1 });
    },
    releaseGiftCardClaim(id, callback) {
      if (card.status === 'redeemed' && card.redeemed_order_id === null) {
        card.status = 'approved';
        card.redeemed_by_user_id = null;
        return callback(null, { changes: 1 });
      }
      callback(null, { changes: 0 });
    },
    getSetting(key, callback) {
      callback(null, { value: key === 'group_id' ? '1234' : '' });
    },
    getActiveOrderForUser(userId, callback) {
      callback(null, state.orders.find((o) => o.user_id === userId && o.status !== ORDER_STATUS.COMPLETED) || null);
    },
    createGroupOrder(userId, robux, mnt, rate, reference, delivered, bonus, callback) {
      const order = {
        id: state.nextOrderId,
        user_id: userId,
        status: ORDER_STATUS.AWAITING_PAYMENT,
        delivered_robux: delivered
      };
      state.nextOrderId += 1;
      state.orders.push(order);
      callback(null, order);
    },
    transitionOrderStatus(id, fromStatuses, toStatus, extraColumns, callback) {
      const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
      const order = state.orders.find((o) => o.id === id);
      if (!order || !from.includes(order.status)) return callback(null, { changes: 0 });
      order.status = toStatus;
      Object.assign(order, extraColumns);
      callback(null, { changes: 1 });
    },
    getPhoneLinkByUserId(userId, callback) {
      callback(null, { user_id: userId, phone: '99001122' });
    },
    // No seller bot configured — see silenceExpectedDeliveryErrors. Delivery
    // stops at GROUP_NOT_CONFIGURED before touching Roblox.
    getActiveSellerBot(callback) { callback(null, null); },
    getOrderWithUser(id, callback) {
      const order = state.orders.find((o) => o.id === id);
      callback(null, order ? { ...order, delivery_method: 'group', roblox_id: '555' } : null);
    },
    appendAuditLog(entry, callback) { state.audit.push(entry); callback(null, {}); }
  };
}

function requestFor(userId, code) {
  return { session: { userId }, body: { code }, ip: '127.0.0.1' };
}

// This file is about who is *allowed* to redeem, not about delivery. The
// controller destructures attemptGroupDelivery at require time, so there is no
// binding left to swap — rather than pretend otherwise, the fixture reports no
// configured seller bot. Delivery then fails fast with GROUP_NOT_CONFIGURED,
// which redeem() catches by design, and the assertions below are about the
// gift card's state rather than the payout.
//
// The expected console.error from that path is swallowed so a passing run
// stays readable; anything unexpected still surfaces.
function silenceExpectedDeliveryErrors() {
  const original = console.error;
  console.error = (...args) => {
    const first = String(args[0] ?? '');
    if (first.startsWith('Immediate gift card delivery error')) return;
    if (first.startsWith('Redeem gift card error')) return;
    original(...args);
  };
  return () => { console.error = original; };
}

async function testSingleRedemptionSucceeds() {
  const db = createStubDb();
  const controller = new GiftCardController(db);
  const res = createResponse();

  await controller.redeem(requestFor(5, 'GIFT-ABCD2345'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(db.state.card.status, 'redeemed');
  assert.equal(db.state.card.redeemed_by_user_id, 5);
  assert.equal(db.state.orders.length, 1, 'exactly one delivery order');
  assert.equal(db.state.card.redeemed_order_id, db.state.orders[0].id, 'card must point at its order');
  console.log('  ✓ a valid gift card redeems once and creates one delivery order');
}

async function testConcurrentRedemptionYieldsOneOrder() {
  // The whole point of a gift card is that the code gets handed to someone
  // else — so two people redeeming the same code at the same moment is
  // ordinary use, not a contrived race. Before the claim was taken up front,
  // both callers passed the status check, both got a delivery order, and one
  // purchase paid out twice.
  const db = createStubDb();
  const controller = new GiftCardController(db);

  const first = createResponse();
  const second = createResponse();

  await Promise.all([
    controller.redeem(requestFor(5, 'GIFT-ABCD2345'), first),
    controller.redeem(requestFor(6, 'GIFT-ABCD2345'), second)
  ]);

  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one winner, one rejected as already used');
  assert.equal(db.state.orders.length, 1, 'a single gift card must never produce two delivery orders');
  assert.equal(db.state.card.status, 'redeemed');
  console.log('  ✓ concurrent redemption of one code produces exactly one payout order');
}

async function testAlreadyRedeemedIsRejected() {
  const db = createStubDb();
  db.state.card.status = 'redeemed';
  const controller = new GiftCardController(db);
  const res = createResponse();

  await controller.redeem(requestFor(5, 'GIFT-ABCD2345'), res);

  assert.equal(res.statusCode, 409);
  assert.equal(db.state.orders.length, 0, 'no order for an already-spent card');
  console.log('  ✓ an already-redeemed card is refused');
}

async function testUnapprovedCardIsRejected() {
  const db = createStubDb();
  db.state.card.status = 'awaiting_payment';
  const controller = new GiftCardController(db);
  const res = createResponse();

  await controller.redeem(requestFor(5, 'GIFT-ABCD2345'), res);

  assert.equal(res.statusCode, 409);
  assert.equal(db.state.orders.length, 0, 'an unpaid card must never deliver');
  console.log('  ✓ a card whose payment is not yet approved is refused');
}

async function testFailedOrderCreationReturnsTheCard() {
  // If the delivery order can't be created, the customer must not be left
  // holding a card marked spent that delivered nothing.
  const db = createStubDb();
  db.createGroupOrder = (...args) => {
    const callback = args[args.length - 1];
    callback(new Error('disk full'));
  };
  const controller = new GiftCardController(db);
  const res = createResponse();

  await controller.redeem(requestFor(5, 'GIFT-ABCD2345'), res);

  assert.equal(res.statusCode, 500);
  assert.equal(db.state.card.status, 'approved', 'the card must be handed back, not consumed');
  assert.equal(db.state.card.redeemed_by_user_id, null);
  console.log('  ✓ a failed order creation releases the card instead of eating it');
}

function testThresholdParsingNeverThrows() {
  // These are parsed on the checkout path. Throwing here used to mean a 500
  // on every order creation and on /profile — the entire storefront down over
  // one settings row.
  for (const bad of ['not json', '{', 'null', '{"a":1}', '"text"', '42', undefined, null, '']) {
    assert.deepEqual(parseThresholds(bad), [], `${String(bad)} should degrade to no levels`);
  }

  // Entries without a usable threshold would sort unpredictably and could
  // hand out the wrong discount, so they're dropped rather than coerced.
  assert.deepEqual(
    parseThresholds('[{"threshold":100,"discountPercent":5},{"discountPercent":9}]'),
    [{ threshold: 100, discountPercent: 5 }]
  );

  // Losing levels degrades a purchase to full price; throwing loses the sale.
  assert.deepEqual(computeLevel(5000, parseThresholds('garbage')), {
    level: 0, threshold: 0, discountPercent: 0, nextLevel: null, nextThreshold: null
  });

  // And a non-array reaching computeLevel directly must not throw either.
  assert.equal(computeLevel(5000, null).discountPercent, 0);
  assert.equal(computeLevel(5000, undefined).discountPercent, 0);

  console.log('  ✓ malformed level_thresholds degrades to no discount instead of a 500');
}

async function run() {
  const restore = silenceExpectedDeliveryErrors();
  try {
    await testSingleRedemptionSucceeds();
    await testConcurrentRedemptionYieldsOneOrder();
    await testAlreadyRedeemedIsRejected();
    await testUnapprovedCardIsRejected();
    await testFailedOrderCreationReturnsTheCard();
    testThresholdParsingNeverThrows();
  } finally {
    restore();
  }
  console.log('Gift card redemption and level parsing tests passed');
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
