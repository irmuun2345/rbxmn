const assert = require('assert');
const RobloxGroup = require('../src/services/roblox-group');

// The rules this file pins down are the ones that decide whether a buyer gets
// paid twice, gets paid the wrong amount, or gets stranded needing an admin.
// Every assertion here corresponds to a way real money goes wrong.

function testAmountValidation() {
  // NaN is the realistic one: upstream sends `delivered_robux || price`, and
  // if a migration ever left both null this is the last thing standing
  // between that and a payout request built from undefined.
  for (const bad of [undefined, null, NaN, 0, -50, 1.5, '', 'abc', Infinity]) {
    assert.throws(
      () => RobloxGroup.assertPayableAmount(bad),
      (error) => error.code === 'INVALID_PAYOUT_AMOUNT' && error.preflight === true,
      `${String(bad)} should be refused before it reaches Roblox`
    );
  }

  // An absurd amount means a pricing bug upstream. Refusing is cheaper than
  // wiring it to Roblox and finding out.
  assert.throws(
    () => RobloxGroup.assertPayableAmount(5000000),
    (error) => error.code === 'PAYOUT_AMOUNT_TOO_LARGE' && error.preflight === true
  );

  assert.equal(RobloxGroup.assertPayableAmount(800), 800);
  assert.equal(RobloxGroup.assertPayableAmount('1200'), 1200);

  console.log('  ✓ payout amounts are validated before any request is built');
}

function testPreflightErrorsAreSafeToRetry() {
  // group-delivery.js keys its entire "is this safe to requeue?" decision off
  // these two flags. A preflight error must always carry `preflight: true`,
  // because that is what returns the order to the queue instead of stranding
  // it for manual resolution.
  const error = (() => {
    try {
      RobloxGroup.assertPayableAmount(-1);
      return null;
    } catch (caught) {
      return caught;
    }
  })();

  assert.ok(error, 'expected a throw');
  assert.equal(error.preflight, true, 'preflight failures must be flagged as never-sent');
}

function testPayoutMatching() {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  const ledger = [
    { agent: { id: 111 }, currency: { amount: -800 }, created: iso(60 * 1000) },
    { agent: { id: 222 }, currency: { amount: -1700 }, created: iso(5 * 60 * 1000) }
  ];

  assert.equal(RobloxGroup.matchPayout(ledger, '111', 800), true, 'should find a matching payout');
  assert.equal(RobloxGroup.matchPayout(ledger, 111, 800), true, 'recipient id type must not matter');

  // Wrong amount to the right person, and the right amount to the wrong
  // person, must both be misses — either one, treated as a match, closes an
  // order that was never actually delivered.
  assert.equal(RobloxGroup.matchPayout(ledger, '111', 1700), false, 'amount must match');
  assert.equal(RobloxGroup.matchPayout(ledger, '333', 800), false, 'recipient must match');

  // An old payout is a different order. Without the window, a buyer's
  // previous purchase would close out their current one.
  const stale = [{ agent: { id: 111 }, currency: { amount: -800 }, created: iso(48 * 60 * 60 * 1000) }];
  assert.equal(RobloxGroup.matchPayout(stale, '111', 800), false, 'payouts outside the window must not match');

  // "Could not read the ledger" must stay distinguishable from "the ledger
  // shows nothing". Collapsing null into false would tell an admin that
  // Roblox confirmed no payout when in fact nothing was checked.
  assert.equal(RobloxGroup.matchPayout(null, '111', 800), null, 'unreadable ledger must return null');
  assert.equal(RobloxGroup.matchPayout(undefined, '111', 800), null);
  assert.equal(RobloxGroup.matchPayout([], '111', 800), false, 'an empty ledger is a real answer');

  console.log('  ✓ payout ledger matching distinguishes found / not-found / unknown');
}

function testCsrfAcquisitionAvoidsLogout() {
  // The old implementation obtained its CSRF token by POSTing to /v2/logout
  // and depending on that call to fail. If it ever succeeded, the bot cookie
  // was invalidated and every delivery stopped until someone noticed.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../src/services/roblox-group.js'),
    'utf8'
  );

  const ticketIndex = source.indexOf('TICKET_URL');
  const logoutIndex = source.indexOf('LOGOUT_URL)');
  assert.ok(ticketIndex !== -1, 'a non-destructive CSRF endpoint must be configured');
  assert.ok(
    ticketIndex < logoutIndex,
    'the harmless endpoint must be tried before the destructive fallback'
  );

  console.log('  ✓ CSRF acquisition prefers a non-destructive endpoint');
}

function testCsrfTokenIsCached() {
  // Without caching, every payout and every join-acceptance costs an extra
  // round trip to an endpoint whose success case logs the bot out.
  let fetches = 0;
  const original = RobloxGroup.fetchCsrfToken;
  RobloxGroup.fetchCsrfToken = async () => {
    fetches += 1;
    return `token-${fetches}`;
  };

  const cookie = `test-cookie-${Date.now()}`;

  return (async () => {
    try {
      const first = await RobloxGroup.getCsrfToken(cookie);
      const second = await RobloxGroup.getCsrfToken(cookie);

      assert.equal(first, second, 'a cached token should be reused');
      assert.equal(fetches, 1, 'the token endpoint should be hit once, not once per call');

      // A rotated token has to be obtainable on demand, or the cache becomes
      // its own failure mode once Roblox expires it.
      const refreshed = await RobloxGroup.getCsrfToken(cookie, { forceRefresh: true });
      assert.equal(refreshed, 'token-2');
      assert.equal(fetches, 2);

      console.log('  ✓ CSRF tokens are cached per bot cookie and refreshable');
    } finally {
      RobloxGroup.fetchCsrfToken = original;
    }
  })();
}

// ---------------------------------------------------------------------------
// Delivery outcome routing
// ---------------------------------------------------------------------------

const { ORDER_STATUS } = require('../src/services/order-status');
const { attemptGroupDelivery } = require('../src/services/group-delivery');

// A database stub holding exactly one group order, eligible for payout. Only
// the helpers the delivery path actually touches are implemented.
function createStubDb(initialStatus = ORDER_STATUS.FULFILLMENT_PENDING) {
  const order = {
    id: 41,
    user_id: 7,
    roblox_id: '555',
    username: 'buyer',
    delivery_method: 'group',
    status: initialStatus,
    price: 800,
    delivered_robux: 880,
    fulfillment_started_at: null,
    fulfillment_error: null
  };

  const settings = { group_id: '1234', group_membership_days: '14' };
  // Joined well over the requirement, so eligibility is never the reason a
  // payout doesn't happen in these tests.
  const joinedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  return {
    order,
    auditEntries: [],
    getOrderWithUser(id, callback) { callback(null, id === order.id ? { ...order } : null); },
    getGamePassById(id, callback) { callback(null, id === order.id ? { ...order } : null); },
    getSetting(key, callback) { callback(null, { value: settings[key] ?? '' }); },
    getActiveSellerBot(callback) { callback(null, { cookie: 'stub-cookie' }); },
    getGroupMembership(userId, groupId, callback) {
      callback(null, { user_id: userId, group_id: groupId, joined_at: joinedAt, source: 'accepted' });
    },
    touchGroupMembership(userId, groupId, callback) { callback(null); },
    deleteGroupMembership(userId, groupId, callback) { callback(null); },
    recordGroupMembership(userId, robloxId, groupId, at, source, callback) { callback(null, {}); },
    creditReferralEarning(orderId, callback) { callback(null, { changes: 0 }); },
    appendAuditLog(entry, callback) { this.auditEntries.push(entry); callback(null, {}); },
    transitionOrderStatus(id, fromStatuses, toStatus, extraColumns, callback) {
      const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
      if (id !== order.id || !from.includes(order.status)) {
        return callback(null, { changes: 0 });
      }
      order.status = toStatus;
      Object.assign(order, extraColumns);
      callback(null, { changes: 1 });
    }
  };
}

async function withStubbedRoblox(overrides, body) {
  const originals = {};
  Object.keys(overrides).forEach((name) => {
    originals[name] = RobloxGroup[name];
    RobloxGroup[name] = overrides[name];
  });

  try {
    return await body();
  } finally {
    Object.keys(originals).forEach((name) => { RobloxGroup[name] = originals[name]; });
  }
}

const stubbedReads = {
  getJoinRequest: async () => null,
  isGroupMember: async () => true
};

async function testSuccessfulDeliveryCompletes() {
  const db = createStubDb();
  let sentAmount = null;

  await withStubbedRoblox(
    { ...stubbedReads, sendPayout: async (groupId, userId, amount) => { sentAmount = amount; } },
    () => attemptGroupDelivery(db, 41)
  );

  assert.equal(sentAmount, 880, 'the bonused amount must be what is sent, not the base package');
  assert.equal(db.order.status, ORDER_STATUS.COMPLETED);
  console.log('  ✓ a successful payout completes the order and sends the bonused amount');
}

async function testPreflightFailureRequeues() {
  const db = createStubDb();

  // Insufficient group funds is the commonest real failure, and nothing was
  // sent — so the order must go back in the queue and deliver itself once the
  // group is topped up, with no admin involvement at all.
  const insufficient = Object.assign(new Error('Group is broke'), {
    code: 'INSUFFICIENT_GROUP_FUNDS',
    preflight: true
  });

  await assert.rejects(
    withStubbedRoblox(
      { ...stubbedReads, sendPayout: async () => { throw insufficient; } },
      () => attemptGroupDelivery(db, 41)
    )
  );

  assert.equal(
    db.order.status,
    ORDER_STATUS.FULFILLMENT_PENDING,
    'a never-sent payout must return the order to the queue, not strand it'
  );

  const failure = db.auditEntries.find((entry) => entry.action === 'order.fulfillment_failed');
  assert.equal(failure.details.payoutMayHaveLanded, false);
  assert.equal(failure.details.requeued, true);
  console.log('  ✓ preflight failures requeue the order instead of stranding it');
}

async function testAmbiguousFailureStrands() {
  const db = createStubDb();

  // A timeout means the request was on the wire. Roblox may have applied it.
  // Retrying is exactly how a buyer gets paid twice, so the order must stay
  // locked until a human states what actually happened.
  const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });

  await assert.rejects(
    withStubbedRoblox(
      { ...stubbedReads, sendPayout: async () => { throw timeout; } },
      () => attemptGroupDelivery(db, 41)
    )
  );

  assert.equal(
    db.order.status,
    ORDER_STATUS.FULFILLMENT_PROCESSING,
    'an ambiguous failure must keep the order locked out of the retry poller'
  );

  const failure = db.auditEntries.find((entry) => entry.action === 'order.fulfillment_failed');
  assert.equal(failure.details.payoutMayHaveLanded, true);
  assert.equal(failure.details.requeued, false);
  console.log('  ✓ ambiguous failures strand the order for manual resolution');
}

async function testStrandedOrderIsNotRetried() {
  // The poller loads FULFILLMENT_PENDING only, but attemptGroupDelivery is
  // also reachable from the admin "check now" button — so it has to refuse a
  // stranded order on its own account too.
  const db = createStubDb(ORDER_STATUS.FULFILLMENT_PROCESSING);
  let payoutCalls = 0;

  await assert.rejects(
    withStubbedRoblox(
      { ...stubbedReads, sendPayout: async () => { payoutCalls += 1; } },
      () => attemptGroupDelivery(db, 41)
    ),
    (error) => error.code === 'WRONG_STATUS'
  );

  assert.equal(payoutCalls, 0, 'a stranded order must never reach the payout call');
  console.log('  ✓ an order already mid-delivery is refused, not paid again');
}

async function run() {
  testAmountValidation();
  testPreflightErrorsAreSafeToRetry();
  testPayoutMatching();
  testCsrfAcquisitionAvoidsLogout();
  await testCsrfTokenIsCached();
  await testSuccessfulDeliveryCompletes();
  await testPreflightFailureRequeues();
  await testAmbiguousFailureStrands();
  await testStrandedOrderIsNotRetried();
  console.log('Payout safety tests passed');
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
