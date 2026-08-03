const orders = require('./orders');
const { ORDER_STATUS } = require('./order-status');
const { ACTIONS, recordSystemAction } = require('./audit');

// Turns a payment a provider has *already confirmed* into an approved order.
//
// This is the one place in the system where money becomes Robux without a
// human looking at it, so the rules are deliberately narrow and every one of
// them fails closed:
//
//   1. The caller must have verified the payment with the provider first.
//      Nothing here trusts a webhook body — see qpay.js for why.
//   2. A provider transaction id is claimed before anything is approved. A
//      re-sent callback loses that claim and stops.
//   3. The reference must resolve to exactly one order or gift card.
//   4. The amount must cover the invoice. Underpayment is never partially
//      fulfilled; it is recorded and left for a human.
//
// Anything that doesn't fit is written to the payments table with a reason
// and left alone. Refusing to act is always available and always safe; the
// customer's money is not lost, it just needs an admin.

const PROVIDER_UNSET = 'unknown';

function promisify(dbHelpers, method, ...args) {
  return new Promise((resolve, reject) => {
    dbHelpers[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

// Reject rather than approve when the reference is ambiguous or absent. Both
// are signs the customer typed something wrong into their transfer, which is
// a support question and not something to guess at.
async function resolveTarget(dbHelpers, reference) {
  if (!reference) return { error: 'MISSING_REFERENCE' };

  const row = await promisify(dbHelpers, 'findByPaymentReference', reference);
  if (!row) return { error: 'UNKNOWN_REFERENCE' };
  return { target: row };
}

/**
 * Applies a confirmed payment.
 *
 * @param {object} confirmation
 *   provider          — 'qpay', 'bank', …
 *   providerPaymentId — the provider's own id for this transaction
 *   reference         — the RBX-XXXXXX code the customer paid against
 *   amountMnt         — the amount the PROVIDER says was paid, not the client
 */
async function applyConfirmedPayment(dbHelpers, confirmation) {
  const provider = confirmation.provider || PROVIDER_UNSET;
  const providerPaymentId = String(confirmation.providerPaymentId || '').trim();
  const reference = String(confirmation.reference || '').trim().toUpperCase();
  const amountMnt = Number(confirmation.amountMnt);

  if (!providerPaymentId) {
    // Without an id there is nothing to deduplicate on, and a payment we
    // can't deduplicate is a payment we could apply twice.
    return { applied: false, reason: 'MISSING_PROVIDER_PAYMENT_ID' };
  }

  const resolved = await resolveTarget(dbHelpers, reference);

  // Claim before doing anything. Even a payment that turns out to be
  // unmatchable takes the id, so a retry of the same bad callback doesn't
  // pile up duplicate rows or repeat the work.
  const claim = await promisify(dbHelpers, 'claimPayment', {
    provider,
    providerPaymentId,
    paymentReference: reference || null,
    amountMnt: Number.isFinite(amountMnt) ? amountMnt : null,
    entityType: resolved.target?.entity_type || null,
    entityId: resolved.target?.id ?? null,
    outcome: 'claimed'
  });

  if (claim.duplicate) {
    // The healthy path for a retried webhook. Answer success so the provider
    // stops retrying, but touch nothing.
    return { applied: false, duplicate: true, reason: 'ALREADY_PROCESSED' };
  }

  const finish = async (outcome, reason, extra = {}) => {
    await promisify(dbHelpers, 'updatePaymentOutcome', claim.id, outcome, reason);
    return { applied: outcome === 'applied', reason, ...extra };
  };

  if (resolved.error) {
    return finish('rejected', resolved.error);
  }

  const target = resolved.target;
  const expected = Number(target.amount_mnt);

  if (!Number.isFinite(amountMnt) || amountMnt <= 0) {
    return finish('rejected', 'INVALID_AMOUNT');
  }

  // Underpayment is never partially fulfilled — a half-paid order that
  // delivers is worse than one that waits for a human. Overpayment is
  // accepted and flagged, because the customer has met their side and
  // refunding the difference is a support task, not a reason to withhold.
  if (Number.isFinite(expected) && amountMnt < expected) {
    return finish('rejected', 'UNDERPAID', { expected, received: amountMnt });
  }

  if (target.entity_type === 'gift_card') {
    return applyToGiftCard(dbHelpers, target, { provider, providerPaymentId, amountMnt, reference, finish });
  }
  return applyToOrder(dbHelpers, target, { provider, providerPaymentId, amountMnt, reference, finish });
}

async function applyToOrder(dbHelpers, target, context) {
  const { provider, providerPaymentId, amountMnt, finish } = context;
  const orderId = target.id;

  // A gateway confirmation is stronger evidence than a photograph of a bank
  // slip, so it stands in for the receipt step: the order walks
  // AWAITING_PAYMENT -> PAYMENT_SUBMITTED -> PAYMENT_APPROVED, exactly the
  // path the declared transition table already allows. No new edges, and an
  // order that is already past this point simply fails the guard.
  const submitted = await orders.markPaymentSubmitted(dbHelpers, orderId);
  if (!submitted && target.status !== ORDER_STATUS.PAYMENT_SUBMITTED
      && target.status !== ORDER_STATUS.UNDER_REVIEW) {
    return finish('rejected', 'ORDER_NOT_AWAITING_PAYMENT', { status: target.status });
  }

  // adminId is null: nobody approved this, the provider did. That distinction
  // is why the audit entry below is a system action rather than an admin one.
  const approved = await orders.markPaymentApproved(dbHelpers, orderId, null);
  if (!approved) {
    return finish('rejected', 'ORDER_NOT_APPROVABLE', { status: target.status });
  }

  await orders.markFulfillmentPending(dbHelpers, orderId);

  await recordSystemAction(dbHelpers, ACTIONS.ORDER_PAYMENT_APPROVED, {
    entityType: 'order',
    entityId: orderId,
    details: {
      automatic: true,
      provider,
      providerPaymentId,
      amountMnt,
      expectedMnt: target.amount_mnt,
      overpaid: amountMnt > Number(target.amount_mnt)
    }
  });

  return finish('applied', 'ORDER_APPROVED', { entityType: 'order', entityId: orderId });
}

async function applyToGiftCard(dbHelpers, target, context) {
  const { provider, providerPaymentId, amountMnt, finish } = context;

  const result = await promisify(dbHelpers, 'markGiftCardPaymentReceived', target.id);
  if (!result.changes) {
    return finish('rejected', 'GIFT_CARD_NOT_AWAITING_PAYMENT', { status: target.status });
  }

  await recordSystemAction(dbHelpers, ACTIONS.GIFT_CARD_APPROVED, {
    entityType: 'gift_card',
    entityId: target.id,
    details: { automatic: true, provider, providerPaymentId, amountMnt }
  });

  return finish('applied', 'GIFT_CARD_APPROVED', { entityType: 'gift_card', entityId: target.id });
}

module.exports = { applyConfirmedPayment };
