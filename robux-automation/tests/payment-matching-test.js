const assert = require('assert');
const { applyConfirmedPayment } = require('../src/services/payments');
const { ORDER_STATUS } = require('../src/services/order-status');

// This is the only path where money becomes Robux with no human in the loop,
// so each test below is a way that could go wrong with someone's money.

function createStubDb({ orderStatus = ORDER_STATUS.AWAITING_PAYMENT, amountMnt = 36000 } = {}) {
  const order = {
    id: 41,
    owner_id: 7,
    user_id: 7,
    amount_mnt: amountMnt,
    status: orderStatus,
    entity_type: 'order',
    payment_reference: 'RBX-K7M2QP'
  };

  const giftCard = {
    id: 9,
    owner_id: 3,
    amount_mnt: 50000,
    price_mnt: 50000,
    status: 'awaiting_payment',
    entity_type: 'gift_card',
    payment_reference: 'RBX-GIFT99'
  };

  const state = { order, giftCard, payments: [], audit: [], nextPaymentId: 1 };

  return {
    state,
    findByPaymentReference(reference, callback) {
      if (reference === order.payment_reference) {
        return callback(null, { ...order });
      }
      if (reference === giftCard.payment_reference) {
        return callback(null, { ...giftCard, amount_mnt: giftCard.price_mnt });
      }
      callback(null, null);
    },
    claimPayment(payment, callback) {
      const clash = state.payments.find((p) => (
        p.provider === payment.provider && p.provider_payment_id === payment.providerPaymentId
      ));
      if (clash) return callback(null, { duplicate: true });

      const row = {
        id: state.nextPaymentId,
        provider: payment.provider,
        provider_payment_id: payment.providerPaymentId,
        payment_reference: payment.paymentReference,
        amount_mnt: payment.amountMnt,
        outcome: payment.outcome
      };
      state.nextPaymentId += 1;
      state.payments.push(row);
      callback(null, { duplicate: false, id: row.id });
    },
    updatePaymentOutcome(id, outcome, reason, callback) {
      const row = state.payments.find((p) => p.id === id);
      if (row) { row.outcome = outcome; row.reason = reason; }
      callback(null, { changes: row ? 1 : 0 });
    },
    transitionOrderStatus(id, fromStatuses, toStatus, extraColumns, callback) {
      const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
      if (id !== order.id || !from.includes(order.status)) return callback(null, { changes: 0 });
      order.status = toStatus;
      Object.assign(order, extraColumns);
      callback(null, { changes: 1 });
    },
    markGiftCardPaymentReceived(id, callback) {
      if (id !== giftCard.id || giftCard.status !== 'awaiting_payment') {
        return callback(null, { changes: 0 });
      }
      giftCard.status = 'approved';
      callback(null, { changes: 1 });
    },
    creditReferralEarning(orderId, callback) { callback(null, { changes: 0 }); },
    appendAuditLog(entry, callback) { state.audit.push(entry); callback(null, {}); },
    // No group configured, so the immediate-delivery attempt the controller
    // makes after approving stops at GROUP_NOT_CONFIGURED. That is deliberate:
    // it also demonstrates the property that a delivery failure never undoes
    // an approved payment — the order stays queued for the poller.
    getOrderWithUser(id, callback) {
      callback(null, id === order.id ? { ...order, delivery_method: 'group', roblox_id: '555' } : null);
    },
    getSetting(key, callback) { callback(null, { value: '' }); },
    getActiveSellerBot(callback) { callback(null, null); }
  };
}

const confirmation = (overrides = {}) => ({
  provider: 'qpay',
  providerPaymentId: 'qpay-tx-1',
  reference: 'RBX-K7M2QP',
  amountMnt: 36000,
  ...overrides
});

async function testExactPaymentApprovesAndQueues() {
  const db = createStubDb();
  const result = await applyConfirmedPayment(db, confirmation());

  assert.equal(result.applied, true);
  assert.equal(
    db.state.order.status,
    ORDER_STATUS.FULFILLMENT_PENDING,
    'a confirmed payment must land the order in the delivery queue with no admin step'
  );

  const entry = db.state.audit.find((e) => e.action === 'order.payment_approved');
  assert.equal(entry.actorType, 'system', 'nobody approved this — the provider did');
  assert.equal(entry.details.automatic, true);
  console.log('  ✓ an exact payment approves the order and queues delivery automatically');
}

async function testReplayedCallbackIsIgnored() {
  // Gateways re-send callbacks on timeout and retry. Applying one twice would
  // be a second delivery for a single payment.
  const db = createStubDb();

  const first = await applyConfirmedPayment(db, confirmation());
  const second = await applyConfirmedPayment(db, confirmation());

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.state.payments.length, 1, 'the transaction must be recorded exactly once');
  assert.equal(db.state.order.status, ORDER_STATUS.FULFILLMENT_PENDING, 'status must not advance again');
  console.log('  ✓ a replayed callback is refused by the idempotency claim');
}

async function testConcurrentCallbacksApplyOnce() {
  const db = createStubDb();
  const results = await Promise.all([
    applyConfirmedPayment(db, confirmation()),
    applyConfirmedPayment(db, confirmation())
  ]);

  assert.equal(results.filter((r) => r.applied).length, 1, 'exactly one may apply');
  assert.equal(db.state.payments.length, 1);
  console.log('  ✓ two simultaneous callbacks for one payment apply once');
}

async function testUnderpaymentIsRefused() {
  // A half-paid order that delivers is worse than one that waits.
  const db = createStubDb();
  const result = await applyConfirmedPayment(db, confirmation({ amountMnt: 20000 }));

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UNDERPAID');
  assert.equal(db.state.order.status, ORDER_STATUS.AWAITING_PAYMENT, 'the order must not move');
  assert.equal(db.state.payments[0].outcome, 'rejected', 'and the attempt must be visible to support');
  console.log('  ✓ underpayment is refused and recorded, never partially fulfilled');
}

async function testOverpaymentIsAcceptedAndFlagged() {
  // The customer met their side. Refunding the difference is a support task,
  // not a reason to withhold what they bought.
  const db = createStubDb();
  const result = await applyConfirmedPayment(db, confirmation({ amountMnt: 40000 }));

  assert.equal(result.applied, true);
  assert.equal(db.state.order.status, ORDER_STATUS.FULFILLMENT_PENDING);
  const entry = db.state.audit.find((e) => e.action === 'order.payment_approved');
  assert.equal(entry.details.overpaid, true, 'the overpayment must be flagged for a refund');
  console.log('  ✓ overpayment is honoured and flagged rather than withheld');
}

async function testUnknownReferenceIsRecordedNotApplied() {
  const db = createStubDb();
  const result = await applyConfirmedPayment(db, confirmation({ reference: 'RBX-NOTREAL' }));

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UNKNOWN_REFERENCE');
  assert.equal(db.state.payments[0].outcome, 'rejected');
  assert.equal(
    db.state.payments[0].payment_reference,
    'RBX-NOTREAL',
    'a mistyped reference must be findable when the customer complains'
  );
  console.log('  ✓ an unmatched reference is recorded for support, not guessed at');
}

async function testMissingProviderIdIsRefused() {
  // Without an id there is nothing to deduplicate on, and a payment we cannot
  // deduplicate is one we could apply twice.
  const db = createStubDb();
  const result = await applyConfirmedPayment(db, confirmation({ providerPaymentId: '' }));

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'MISSING_PROVIDER_PAYMENT_ID');
  assert.equal(db.state.payments.length, 0);
  console.log('  ✓ a confirmation with no transaction id is refused outright');
}

async function testAlreadyDeliveredOrderIsNotReapproved() {
  // A late callback for an order that already completed must not walk it
  // backwards into the delivery queue.
  const db = createStubDb({ orderStatus: ORDER_STATUS.COMPLETED });
  const result = await applyConfirmedPayment(db, confirmation());

  assert.equal(result.applied, false);
  assert.equal(db.state.order.status, ORDER_STATUS.COMPLETED, 'a completed order must stay completed');
  console.log('  ✓ a late callback cannot re-queue a completed order');
}

async function testReferenceIsCaseInsensitive() {
  // Bank apps and customers do not respect case in a hand-typed reference.
  const db = createStubDb();
  const result = await applyConfirmedPayment(db, confirmation({ reference: 'rbx-k7m2qp' }));

  assert.equal(result.applied, true, 'a lowercase reference must still match');
  console.log('  ✓ references match case-insensitively');
}

async function testGiftCardPaymentApproves() {
  const db = createStubDb();
  const result = await applyConfirmedPayment(db, confirmation({
    reference: 'RBX-GIFT99',
    amountMnt: 50000,
    providerPaymentId: 'qpay-tx-gift'
  }));

  assert.equal(result.applied, true);
  assert.equal(db.state.giftCard.status, 'approved', 'the code becomes redeemable');
  console.log('  ✓ a gift card payment approves the card');
}

// ---------------------------------------------------------------------------
// Forged callbacks
// ---------------------------------------------------------------------------

// The callback endpoint is open to the internet by necessity — the gateway
// calls it, not a logged-in browser. So the property that actually protects
// the money is that the handler believes QPay's API, never the request.
async function testForgedCallbackCreditsNothing() {
  const PaymentController = require('../src/controllers/payment-controller');
  const qpay = require('../src/services/qpay');

  const db = createStubDb();
  const controller = new PaymentController(db);

  const original = qpay.verifyPayment;
  let askedFor = null;
  // Stand in for QPay answering "I have no record of that payment", which is
  // what a made-up id gets in reality.
  qpay.verifyPayment = async (invoiceId) => { askedFor = invoiceId; return null; };

  try {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };

    // An attacker POSTs a payment they invented, for an amount they chose,
    // against a real order's reference.
    await controller.handleQpayCallback({
      query: { qpay_payment_id: 'forged-1', reference: 'RBX-K7M2QP', amount: '999999' },
      body: { payment_amount: 999999, payment_status: 'PAID' }
    }, res);

    assert.equal(askedFor, 'forged-1', 'the handler must go and ask QPay about it');
    assert.equal(res.body.applied, false, 'nothing may be credited');
    assert.equal(
      db.state.order.status,
      ORDER_STATUS.AWAITING_PAYMENT,
      'the order must not move on the strength of a request body'
    );
    assert.equal(db.state.payments.length, 0, 'no payment may be recorded as received');
    console.log('  ✓ a forged callback claiming PAID credits nothing');
  } finally {
    qpay.verifyPayment = original;
  }
}

async function testAmountComesFromTheProviderNotTheRequest() {
  const PaymentController = require('../src/controllers/payment-controller');
  const qpay = require('../src/services/qpay');

  const db = createStubDb();
  const controller = new PaymentController(db);
  const original = qpay.verifyPayment;

  // QPay says 36,000₮ was paid. The request claims far more.
  qpay.verifyPayment = async () => ({
    paid: true,
    providerPaymentId: 'qpay-real-1',
    amountMnt: 36000,
    reference: 'RBX-K7M2QP'
  });

  try {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await controller.handleQpayCallback({
      query: { qpay_payment_id: 'x', reference: 'RBX-GIFT99' },
      body: { payment_amount: 999999 }
    }, res);

    // The reference and amount both came from QPay's record, so the payment
    // landed on the order QPay says it was for — not the one the query
    // string named.
    assert.equal(db.state.payments[0].amount_mnt, 36000, 'amount must come from the provider');
    assert.equal(db.state.payments[0].payment_reference, 'RBX-K7M2QP', 'reference must come from the provider');
    assert.equal(db.state.giftCard.status, 'awaiting_payment', 'the reference in the URL must be ignored');
    console.log('  ✓ amount and reference are taken from the provider, not the caller');
  } finally {
    qpay.verifyPayment = original;
  }
}

async function run() {
  await testForgedCallbackCreditsNothing();
  await testAmountComesFromTheProviderNotTheRequest();
  await testExactPaymentApprovesAndQueues();
  await testReplayedCallbackIsIgnored();
  await testConcurrentCallbacksApplyOnce();
  await testUnderpaymentIsRefused();
  await testOverpaymentIsAcceptedAndFlagged();
  await testUnknownReferenceIsRecordedNotApplied();
  await testMissingProviderIdIsRefused();
  await testAlreadyDeliveredOrderIsNotReapproved();
  await testReferenceIsCaseInsensitive();
  await testGiftCardPaymentApproves();
  console.log('Automatic payment matching tests passed');
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
