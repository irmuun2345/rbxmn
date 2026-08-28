// One vocabulary for what an order's status *looks* like.
//
// Mirrors src/services/order-status.js. It used to live inside order.js,
// which was fine while the only order on screen was the one being placed —
// but the history list shows the other nine at the same time, and two copies
// of this table would drift the first time a status was renamed.
//
// Each entry drives four things: the badge wording and colour, the position
// on the four-step payment stepper, the explanatory line under the payment
// panel, and whether the row is one the *buyer* still has to act on.

export const ORDER_STATUS_VIEW = {
  requested: {
    label: 'Захиалга үүссэн', badge: 'badge-pending', tone: 'pending', step: 2
  },
  awaiting_payment: {
    label: 'Төлбөр хүлээж байна', badge: 'badge-pending', tone: 'pending', step: 2,
    // The buyer owes us money or a receipt. This is the only kind of row
    // worth surfacing on the tab as a count.
    actionable: true
  },
  payment_submitted: {
    label: 'Баримт илгээгдсэн', badge: 'badge-active', tone: 'active', step: 3,
    note: 'Баримт хүлээн авлаа. Админ шалгаж байна.'
  },
  under_review: {
    label: 'Шалгаж байна', badge: 'badge-active', tone: 'active', step: 3,
    note: 'Админ таны баримтыг шалгаж байна.'
  },
  payment_approved: {
    label: 'Төлбөр баталгаажсан', badge: 'badge-active', tone: 'active', step: 4,
    note: 'Админ таны төлбөрийг баталгаажууллаа. Хүргэлтэд бэлтгэж байна.'
  },
  payment_rejected: {
    label: 'Төлбөр татгалзсан', badge: 'badge-danger', tone: 'danger', step: 2,
    terminal: false, actionable: true
  },
  fulfillment_pending: {
    label: 'Хүргэлт хүлээгдэж байна', badge: 'badge-active', tone: 'active', step: 4,
    note: 'Төлбөр баталгаажлаа. Таны Robux удахгүй хүргэгдэнэ.'
  },
  fulfillment_processing: {
    label: 'Хүргэлт явагдаж байна', badge: 'badge-active', tone: 'active', step: 4,
    note: 'Robux хүргэх үйлдэл явагдаж байна.'
  },
  completed: {
    label: 'Дууссан', badge: 'badge-ok', tone: 'ok', step: 5, terminal: true,
    note: 'Таны Robux амжилттай хүргэгдлээ. Баярлалаа!'
  },
  failed: {
    label: 'Амжилтгүй', badge: 'badge-danger', tone: 'danger', step: 4, terminal: true,
    note: 'Хүргэлт амжилтгүй боллоо. Админтай холбогдоно уу.'
  }
};

// Orders placed before the status vocabulary existed carry 'legacy'. They are
// real orders and belong in the history, so they get a view of their own
// rather than falling through as a blank badge.
const UNKNOWN_VIEW = {
  label: 'Хуучин захиалга', badge: '', tone: '', step: 5, terminal: true
};

export function statusView(status) {
  return ORDER_STATUS_VIEW[status] || UNKNOWN_VIEW;
}

// The gift card's own three states, in the same four fields, because gift
// cards are now rows in the same history list as orders and a list where two
// kinds of row use two colour vocabularies is a list you read twice.
//
// There is no stepper for these, so no `step`: a gift card is bought and then
// either usable or used.
export const GIFT_STATUS_VIEW = {
  awaiting_payment: {
    label: 'Төлбөр хүлээж байна', badge: 'badge-pending', tone: 'pending', actionable: true
  },
  approved: {
    label: 'Ашиглах боломжтой', badge: 'badge-ok', tone: 'ok', terminal: true,
    note: 'Төлбөр баталгаажлаа. Доорх кодыг бэлэглэх хүндээ дамжуулна уу.'
  },
  redeemed: {
    label: 'Ашигласан', badge: '', tone: '', terminal: true,
    note: 'Энэ карт ашиглагдсан. Нэг код зөвхөн нэг удаа ажиллана.'
  }
};

export function giftStatusView(status) {
  return GIFT_STATUS_VIEW[status] || UNKNOWN_VIEW;
}

// Which filter chip a history row falls under. Derived from the view rather
// than from the status string so the two kinds of row sort themselves the
// same way without the filters needing to know either vocabulary.
export function bucketFor(view, { failed = false } = {}) {
  if (failed) return 'failed';
  if (view.actionable) return 'action';
  if (view.terminal) return 'done';
  return 'progress';
}

// The states in which the buyer still owes us a receipt — and therefore the
// states in which reopening the order should put the upload box back.
export const CAN_UPLOAD_RECEIPT = ['awaiting_payment', 'payment_rejected'];

// Anything not finished is still worth watching, so reopening it starts the
// status poll again.
export const isOpen = (status) => !statusView(status).terminal;

// The buckets the history filter offers. Order matters: it is the order the
// chips are rendered in, and 'all' has to come first.
//
// These match on the bucket bucketFor() already assigned each row, not on a
// status string — the list now carries gift cards as well as orders, and
// 'approved' means finished on one and nothing at all on the other.
export const ORDER_FILTERS = [
  { id: 'all', label: 'Бүгд' },
  { id: 'action', label: 'Хүлээгдэж буй' },
  { id: 'progress', label: 'Явагдаж байна' },
  { id: 'done', label: 'Дууссан' },
  { id: 'failed', label: 'Амжилтгүй' }
];
