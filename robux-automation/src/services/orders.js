const { ORDER_STATUS } = require('./order-status');

// Promise wrappers around the callback-style db helpers, plus the named
// transitions the rest of the app performs. Everything funnels through
// dbHelpers.transitionOrderStatus, which only updates rows still sitting in
// an expected `from` state — so each of these returns true exactly once for
// a given order, no matter how many callers race.

function getOrder(dbHelpers, orderId) {
  return new Promise((resolve, reject) => {
    dbHelpers.getGamePassById(orderId, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function getOrderWithUser(dbHelpers, orderId) {
  return new Promise((resolve, reject) => {
    dbHelpers.getOrderWithUser(orderId, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function transition(dbHelpers, orderId, fromStatuses, toStatus, extraColumns = {}) {
  return new Promise((resolve, reject) => {
    dbHelpers.transitionOrderStatus(orderId, fromStatuses, toStatus, extraColumns, (error, result) => (
      error ? reject(error) : resolve(Boolean(result.changes))
    ));
  });
}

// Buyer has uploaded a receipt. Reachable from AWAITING_PAYMENT and also from
// PAYMENT_REJECTED, so someone whose first receipt was wrong can simply send
// a corrected one instead of starting a new order.
function markPaymentSubmitted(dbHelpers, orderId) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_REJECTED],
    ORDER_STATUS.PAYMENT_SUBMITTED,
    { rejection_reason: null }
  );
}

// Admin has opened the receipt. Advisory only — approve/reject accept both
// PAYMENT_SUBMITTED and UNDER_REVIEW, so two admins looking at once is fine.
function markUnderReview(dbHelpers, orderId, adminId) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.PAYMENT_SUBMITTED],
    ORDER_STATUS.UNDER_REVIEW,
    { reviewed_by_admin_id: adminId }
  );
}

function markPaymentApproved(dbHelpers, orderId, adminId) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.PAYMENT_SUBMITTED, ORDER_STATUS.UNDER_REVIEW],
    ORDER_STATUS.PAYMENT_APPROVED,
    { reviewed_by_admin_id: adminId, reviewed_at: new Date().toISOString() }
  );
}

function markPaymentRejected(dbHelpers, orderId, adminId, reason) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.PAYMENT_SUBMITTED, ORDER_STATUS.UNDER_REVIEW],
    ORDER_STATUS.PAYMENT_REJECTED,
    {
      reviewed_by_admin_id: adminId,
      reviewed_at: new Date().toISOString(),
      rejection_reason: reason
    }
  );
}

// Approval and "ready to deliver" are separate hops: an approved order waits
// here until the fulfillment route has actually been resolved for it.
function markFulfillmentPending(dbHelpers, orderId) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.PAYMENT_APPROVED],
    ORDER_STATUS.FULFILLMENT_PENDING
  );
}

// The delivery lock. Winning this transition is what grants the caller the
// right to talk to Roblox about this order; losing it means someone else
// already has. Never call a payout/purchase API without winning it first.
function claimForFulfillment(dbHelpers, orderId) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.FULFILLMENT_PENDING],
    ORDER_STATUS.FULFILLMENT_PROCESSING,
    { fulfillment_started_at: new Date().toISOString(), fulfillment_error: null }
  );
}

// Releases the lock for a delivery we are *certain* never reached Roblox —
// only safe when the precondition failed locally (buyer not in the group
// yet, eligibility not matured). Never call this after a payout request has
// actually been sent.
function releaseFulfillmentClaim(dbHelpers, orderId, reason) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.FULFILLMENT_PROCESSING],
    ORDER_STATUS.FULFILLMENT_PENDING,
    { fulfillment_started_at: null, fulfillment_error: reason || null }
  );
}

// The one place an order becomes COMPLETED, whichever route delivered it.
//
// Referral commission is credited here, and only here, for exactly that
// reason: "the customer actually received their Robux" and "this order is
// COMPLETED" are the same statement, so hanging the payout off this
// transition makes it impossible for an approved-but-undelivered order to
// pay a creator. The transition returning true also means it ran once, so
// the credit runs once.
async function markCompleted(dbHelpers, orderId) {
  const moved = await transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.FULFILLMENT_PROCESSING],
    ORDER_STATUS.COMPLETED,
    { completed_at: new Date().toISOString(), fulfillment_error: null }
  );

  if (moved) {
    // Required lazily: referrals.js imports order-status, and a top-level
    // require here would close the cycle.
    await require('./referrals').creditEarningForOrder(dbHelpers, orderId);
  }

  return moved;
}

// A failed order delivered nothing, so any pending commission on it is
// cancelled rather than left to linger as a claim that might later be paid.
async function markFailed(dbHelpers, orderId, reason) {
  const moved = await transition(
    dbHelpers,
    orderId,
    [
      ORDER_STATUS.REQUESTED,
      ORDER_STATUS.AWAITING_PAYMENT,
      ORDER_STATUS.PAYMENT_APPROVED,
      ORDER_STATUS.PAYMENT_REJECTED,
      ORDER_STATUS.FULFILLMENT_PENDING,
      ORDER_STATUS.FULFILLMENT_PROCESSING
    ],
    ORDER_STATUS.FAILED,
    { fulfillment_error: reason || null }
  );

  if (moved) {
    await require('./referrals').reverseEarningForOrder(dbHelpers, orderId);
  }

  return moved;
}

// Records why an in-flight delivery errored without moving the order. The
// row stays in FULFILLMENT_PROCESSING precisely because we don't know
// whether Roblox applied it, so it stays out of the retry poller.
function recordFulfillmentError(dbHelpers, orderId, reason) {
  return transition(
    dbHelpers,
    orderId,
    [ORDER_STATUS.FULFILLMENT_PROCESSING],
    ORDER_STATUS.FULFILLMENT_PROCESSING,
    { fulfillment_error: String(reason || '').slice(0, 500) }
  );
}

module.exports = {
  getOrder,
  getOrderWithUser,
  transition,
  markPaymentSubmitted,
  markUnderReview,
  markPaymentApproved,
  markPaymentRejected,
  markFulfillmentPending,
  claimForFulfillment,
  releaseFulfillmentClaim,
  markCompleted,
  markFailed,
  recordFulfillmentError
};
