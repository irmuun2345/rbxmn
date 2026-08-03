// The single source of truth for where an order is in its life. Every other
// module imports these constants rather than writing the string inline, so a
// typo becomes a crash at require-time instead of a row that silently never
// matches a WHERE clause.
//
// The flow, straight from the spec:
//
//   REQUESTED -> AWAITING PAYMENT -> PAYMENT SUBMITTED -> UNDER REVIEW
//     -> PAYMENT APPROVED / REJECTED -> FULFILLMENT PENDING
//     -> FULFILLMENT PROCESSING -> COMPLETED / FAILED
//
// PAYMENT_APPROVED is a real, persisted state rather than an instant hop to
// FULFILLMENT_PENDING: admin approval and the decision about *how* to fulfil
// are separate concerns, and keeping them separate is what lets an approved
// order sit safely while the buyer's group eligibility matures.

const ORDER_STATUS = {
  REQUESTED: 'requested',
  AWAITING_PAYMENT: 'awaiting_payment',
  PAYMENT_SUBMITTED: 'payment_submitted',
  UNDER_REVIEW: 'under_review',
  PAYMENT_APPROVED: 'payment_approved',
  PAYMENT_REJECTED: 'payment_rejected',
  FULFILLMENT_PENDING: 'fulfillment_pending',
  FULFILLMENT_PROCESSING: 'fulfillment_processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  // Rows created before the status flow existed. Excluded from every queue.
  LEGACY: 'legacy'
};

// Which status may follow which. Enforced by assertTransition below so an
// out-of-order admin click or a duplicated webhook can't walk an order
// backwards (e.g. COMPLETED -> FULFILLMENT_PENDING, which would re-deliver).
const ALLOWED_TRANSITIONS = {
  [ORDER_STATUS.REQUESTED]: [ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.FAILED],
  [ORDER_STATUS.AWAITING_PAYMENT]: [ORDER_STATUS.PAYMENT_SUBMITTED, ORDER_STATUS.FAILED],
  [ORDER_STATUS.PAYMENT_SUBMITTED]: [
    ORDER_STATUS.UNDER_REVIEW,
    ORDER_STATUS.PAYMENT_APPROVED,
    ORDER_STATUS.PAYMENT_REJECTED
  ],
  [ORDER_STATUS.UNDER_REVIEW]: [ORDER_STATUS.PAYMENT_APPROVED, ORDER_STATUS.PAYMENT_REJECTED],
  // A rejection is not the end of the road — the buyer can upload a corrected
  // receipt, which puts them back in the review queue.
  [ORDER_STATUS.PAYMENT_REJECTED]: [ORDER_STATUS.PAYMENT_SUBMITTED, ORDER_STATUS.FAILED],
  [ORDER_STATUS.PAYMENT_APPROVED]: [ORDER_STATUS.FULFILLMENT_PENDING, ORDER_STATUS.FAILED],
  [ORDER_STATUS.FULFILLMENT_PENDING]: [ORDER_STATUS.FULFILLMENT_PROCESSING, ORDER_STATUS.FAILED],
  // No path back to FULFILLMENT_PENDING. Once a payout call has been made we
  // can never be sure it didn't land, so re-queueing it automatically is
  // exactly the double-delivery bug we're guarding against. An admin has to
  // look at Roblox and resolve it by hand.
  [ORDER_STATUS.FULFILLMENT_PROCESSING]: [ORDER_STATUS.COMPLETED, ORDER_STATUS.FAILED],
  [ORDER_STATUS.COMPLETED]: [],
  [ORDER_STATUS.FAILED]: [],
  [ORDER_STATUS.LEGACY]: []
};

// Statuses where the buyer still owes us a payment action.
const OPEN_FOR_BUYER = [
  ORDER_STATUS.AWAITING_PAYMENT,
  ORDER_STATUS.PAYMENT_REJECTED
];

// An order occupying the user's single "in flight" slot. A new order can't be
// created while one of these exists, because both fulfillment routes can only
// track one delivery per account at a time.
const ACTIVE_STATUSES = [
  ORDER_STATUS.REQUESTED,
  ORDER_STATUS.AWAITING_PAYMENT,
  ORDER_STATUS.PAYMENT_SUBMITTED,
  ORDER_STATUS.UNDER_REVIEW,
  ORDER_STATUS.PAYMENT_APPROVED,
  ORDER_STATUS.PAYMENT_REJECTED,
  ORDER_STATUS.FULFILLMENT_PENDING,
  ORDER_STATUS.FULFILLMENT_PROCESSING
];

// Statuses an admin needs to act on, in the order the queue should show them.
const ADMIN_QUEUE_STATUSES = [
  ORDER_STATUS.PAYMENT_SUBMITTED,
  ORDER_STATUS.UNDER_REVIEW,
  ORDER_STATUS.PAYMENT_APPROVED,
  ORDER_STATUS.FULFILLMENT_PENDING,
  ORDER_STATUS.FULFILLMENT_PROCESSING
];

const TERMINAL_STATUSES = [ORDER_STATUS.COMPLETED, ORDER_STATUS.FAILED];

// Buyer-facing Mongolian labels. Kept here next to the statuses themselves so
// adding a state can't leave the UI rendering a raw enum value.
const STATUS_LABELS_MN = {
  [ORDER_STATUS.REQUESTED]: 'Захиалга үүссэн',
  [ORDER_STATUS.AWAITING_PAYMENT]: 'Төлбөр хүлээж байна',
  [ORDER_STATUS.PAYMENT_SUBMITTED]: 'Баримт илгээгдсэн',
  [ORDER_STATUS.UNDER_REVIEW]: 'Шалгаж байна',
  [ORDER_STATUS.PAYMENT_APPROVED]: 'Төлбөр баталгаажсан',
  [ORDER_STATUS.PAYMENT_REJECTED]: 'Төлбөр татгалзсан',
  [ORDER_STATUS.FULFILLMENT_PENDING]: 'Хүргэлт хүлээгдэж байна',
  [ORDER_STATUS.FULFILLMENT_PROCESSING]: 'Хүргэлт явагдаж байна',
  [ORDER_STATUS.COMPLETED]: 'Дууссан',
  [ORDER_STATUS.FAILED]: 'Амжилтгүй',
  [ORDER_STATUS.LEGACY]: 'Хуучин захиалга'
};

function isValidStatus(status) {
  return Object.values(ORDER_STATUS).includes(status);
}

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

// Throws rather than returning false: an illegal transition always means a
// caller bug, and failing loudly beats writing a nonsensical row.
function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw Object.assign(
      new Error(`Захиалгын төлөв ${from} -> ${to} руу шилжих боломжгүй.`),
      { code: 'INVALID_STATUS_TRANSITION', from, to }
    );
  }
}

function statusLabel(status) {
  return STATUS_LABELS_MN[status] || status;
}

// Helper for building `status IN (?, ?, ...)` clauses without hand-counting
// placeholders at each call site.
function placeholders(list) {
  return list.map(() => '?').join(', ');
}

module.exports = {
  ORDER_STATUS,
  ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
  ADMIN_QUEUE_STATUSES,
  OPEN_FOR_BUYER,
  TERMINAL_STATUSES,
  STATUS_LABELS_MN,
  isValidStatus,
  canTransition,
  assertTransition,
  statusLabel,
  placeholders
};
