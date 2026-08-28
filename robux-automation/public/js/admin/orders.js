// The purchase queue — the screen an admin actually works from.
//
// Two decisions live here and nowhere else: approving a bank transfer, and
// confirming a delivery. Both are recorded server-side in the audit log; this
// file only collects the click.

import { $, escapeHtml, showResult } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt, formatNumber } from '../common/format.js';
import { askRejectionReason } from './dialog.js';

// Mirrors src/services/order-status.js.
const STATUS_VIEW = {
  requested:              { label: 'Захиалга үүссэн',         badge: 'badge-pending' },
  awaiting_payment:       { label: 'Төлбөр хүлээж буй',       badge: 'badge-pending' },
  payment_submitted:      { label: 'Баримт илгээгдсэн',       badge: 'badge-pending' },
  under_review:           { label: 'Шалгаж байна',            badge: 'badge-pending' },
  payment_approved:       { label: 'Төлбөр баталгаажсан',     badge: 'badge-active'  },
  payment_rejected:       { label: 'Татгалзсан',              badge: 'badge-danger'  },
  fulfillment_pending:    { label: 'Хүргэлт хүлээгдэж буй',   badge: 'badge-active'  },
  fulfillment_processing: { label: 'Хүргэлт явагдаж буй',     badge: 'badge-active'  },
  completed:              { label: 'Дууссан',                 badge: 'badge-active'  },
  failed:                 { label: 'Амжилтгүй',               badge: 'badge-danger'  },
  legacy:                 { label: 'Хуучин',                  badge: 'badge-pending' }
};

// Review actions belong on the states where a receipt is waiting; delivery
// actions on the states where payment has already cleared.
const AWAITING_REVIEW = ['payment_submitted', 'under_review'];
const READY_TO_DELIVER = 'fulfillment_pending';

// Counted for the stat strip at the top of the page.
const PENDING_REVIEW = ['awaiting_payment', 'payment_submitted', 'under_review'];
const IN_DELIVERY = ['payment_approved', 'fulfillment_pending', 'fulfillment_processing'];

// The buckets an admin actually thinks in. Deliberately coarser than the
// nine statuses: "is this waiting on me, on Roblox, or on nobody" is the
// question being asked, and five chips answer it where nine would just be the
// status column again.
const QUEUE_FILTERS = [
  { id: 'all', label: 'Бүгд', statuses: null },
  { id: 'review', label: 'Шалгах', statuses: PENDING_REVIEW },
  { id: 'delivery', label: 'Хүргэлт', statuses: IN_DELIVERY },
  { id: 'done', label: 'Дууссан', statuses: ['completed'] },
  { id: 'problem', label: 'Асуудалтай', statuses: ['payment_rejected', 'failed'] }
];

// Every order the last fetch returned. The chips and the search box work over
// this rather than re-asking the server: the whole queue arrives in one
// request, so a round trip per keystroke would be slower than the list it is
// searching, and it would put the admin's own approvals a fetch behind.
let queue = [];
let activeFilter = 'all';
let searchTerm = '';

// The same rule the sales search uses, so the two boxes on this page behave
// alike: a username or a reference is matched loosely, because one is
// remembered and the other is read off a bank statement, while a Roblox id is
// matched whole — it is pasted, and '11' as a substring would pull in every
// account that merely contains it.
function matchesSearch(order, term) {
  if (!term) return true;
  const lower = term.toLowerCase();
  return String(order.username || '').toLowerCase().includes(lower)
    || String(order.payment_reference || '').toLowerCase().includes(lower)
    || String(order.roblox_id) === term;
}

function matchesFilter(order, id) {
  const filter = QUEUE_FILTERS.find((entry) => entry.id === id);
  if (!filter || !filter.statuses) return true;
  return filter.statuses.includes(order.status);
}

function statusView(status) {
  return STATUS_VIEW[status] || { label: status, badge: 'badge-pending' };
}

// Receipts are served from an admin-only route, so a plain <img src> works
// inside this authenticated page but the URL is useless to anyone else.
function receiptCell(order) {
  if (!order.receipt_id) return '<small class="dim">Баримт алга</small>';

  const url = `/admin/receipts/${Number(order.receipt_id)}`;
  const extra = Number(order.receipt_count) > 1
    ? `<small class="dim">+${Number(order.receipt_count) - 1} өмнөх</small>`
    : '';
  const preview = order.receipt_mime === 'application/pdf'
    ? '<span class="receipt-thumb receipt-thumb-pdf">PDF</span>'
    : `<img class="receipt-thumb" src="${url}" alt="Төлбөрийн баримт" loading="lazy">`;
  return `<a class="receipt-link" href="${url}" target="_blank" rel="noopener noreferrer">${preview}</a>${extra}`;
}

function actionCell(order, view) {
  if (AWAITING_REVIEW.includes(order.status)) {
    return `<button class="btn btn-sm" type="button" data-payment="${Number(order.id)}">Зөвшөөрөх</button>
            <button class="btn btn-sm btn-danger" type="button" data-reject="${Number(order.id)}">Татгалзах</button>`;
  }
  if (order.status === READY_TO_DELIVER) {
    const label = order.delivery_method === 'group' ? 'Одоо шалгах' : 'Roblox-оос шалгах';
    return `<button class="btn btn-sm" type="button" data-purchased="${Number(order.id)}">${label}</button>`;
  }
  return `<span class="badge ${view.badge}">${escapeHtml(view.label)}</span>`;
}

// The strip counts the whole queue, never the filtered view. It is the one
// place on the page that answers "how much is outstanding", and a number that
// shrank because a search box had two letters in it would be a lie.
function renderStrip() {
  const countOf = (statuses) => queue.filter((order) => statuses.includes(order.status)).length;
  $('payment-orders').textContent = countOf(PENDING_REVIEW);
  $('ready-orders').textContent = countOf(IN_DELIVERY);
  $('purchased-orders').textContent = countOf(['completed']);
}

// Counts are taken within the current search, so a chip reading 0 is telling
// the truth about what pressing it would show — and is disabled rather than
// leading to an empty table.
function renderChips() {
  const searched = queue.filter((order) => matchesSearch(order, searchTerm));

  $('order-filters').innerHTML = QUEUE_FILTERS.map((filter) => {
    const count = searched.filter((order) => matchesFilter(order, filter.id)).length;
    const selected = filter.id === activeFilter;
    return `
      <button class="chip" type="button" role="radio" data-order-filter="${filter.id}"
              aria-checked="${selected}" tabindex="${selected ? 0 : -1}"
              ${count || selected ? '' : 'disabled'}>
        ${escapeHtml(filter.label)}
        <span class="chip-count">${count}</span>
      </button>`;
  }).join('');
}

function visibleOrders() {
  return queue.filter((order) => (
    matchesSearch(order, searchTerm) && matchesFilter(order, activeFilter)
  ));
}

function renderOrders(orders) {
  renderStrip();
  renderChips();

  $('orders-summary').textContent = queue.length
    ? `${orders.length} / ${queue.length} захиалга`
    : '';

  if (!queue.length) {
    $('orders-list').innerHTML = '<tr><td class="empty-cell" colspan="6">Одоогоор захиалга алга.</td></tr>';
    return;
  }

  // The queue is not empty, this view of it is — a different fact, and one an
  // admin fixes by widening the filter rather than by waiting for orders.
  if (!orders.length) {
    $('orders-list').innerHTML =
      '<tr><td class="empty-cell" colspan="6">Энэ шүүлтүүрт тохирох захиалга алга.</td></tr>';
    return;
  }

  $('orders-list').innerHTML = orders.map((order) => {
    const isGroup = order.delivery_method === 'group';
    const view = statusView(order.status);
    return `
      <tr>
        <td data-label="Хэрэглэгч">
          <strong>${escapeHtml(order.username)}</strong>
          <small>Roblox ID ${Number(order.roblox_id)}</small>
        </td>
        <td data-label="Захиалга">
          <strong>${formatNumber(order.price)} Robux</strong>
          <small>${isGroup ? 'Группээр' : `Pass: ${formatNumber(order.listed_price)} Robux`}</small>
        </td>
        <td data-label="Төлбөр">
          <strong>${order.amount_mnt ? formatMnt(order.amount_mnt) : '—'}</strong>
          <small><span class="badge ${view.badge}">${escapeHtml(view.label)}</span></small>
          ${order.payment_reference ? `<span class="ref-code">${escapeHtml(order.payment_reference)}</span>` : ''}
          ${order.rejection_reason ? `<small class="reject-reason">${escapeHtml(order.rejection_reason)}</small>` : ''}
        </td>
        <td data-label="Баримт">${receiptCell(order)}</td>
        <td data-label="Хүргэлт">${isGroup
          ? 'Групп'
          : `<a href="${escapeHtml(order.purchaseUrl)}" target="_blank" rel="noopener noreferrer">#${Number(order.roblox_gamepass_id)} ↗</a>`}</td>
        <td data-label="Үйлдэл" class="action-buttons">${actionCell(order, view)}</td>
      </tr>`;
  }).join('');
}

export async function loadOrders() {
  try {
    const data = await request('/admin/orders', undefined, 'Захиалгын дарааллыг авч чадсангүй.');
    queue = data.orders;
    renderOrders(visibleOrders());
  } catch (error) {
    showResult($('orders-result'), error.message, true);
  }
}

export async function loadAutomationStatus() {
  try {
    const data = await request('/admin/automation-status');
    const oauth = data.oauthConfigured ? 'OAuth холбогдсон' : 'OAuth тохируулаагүй';
    const inventory = data.inventoryVerificationConfigured
      ? `Худалдан авалт шалгах бэлэн · Seller ${data.sellerUserId}`
      : 'Худалдан авалт шалгах тохируулаагүй';
    $('automation-status').textContent = `${oauth} · ${inventory}`;
  } catch (error) {
    $('automation-status').textContent = error.message;
  }
}

export function initOrders() {
  $('order-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-order-filter]');
    if (!chip) return;
    activeFilter = chip.dataset.orderFilter;
    renderOrders(visibleOrders());
  });

  // Redrawn on every keystroke rather than on submit: the rows are already
  // here, so there is nothing to wait for and nothing to press.
  $('order-search').addEventListener('input', (event) => {
    searchTerm = event.target.value.trim();
    renderOrders(visibleOrders());
  });

  $('orders-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-payment], [data-purchased], [data-reject]');
    if (!button) return;

    const rejectId = button.dataset.reject;
    // The reason is mandatory server-side too — this prompt just saves a
    // round trip, since it's the buyer's only explanation of what to fix.
    let reason = null;
    if (rejectId) {
      reason = await askRejectionReason({
        title: 'Төлбөрийг татгалзах',
        message: 'Хэрэглэгч үүнийг шууд харна. Юуг засахыг нь тодорхой бичнэ үү.',
        placeholder: 'Жишээ: Баримт дээрх дүн таарахгүй байна'
      });
      if (reason === null) return;
    }

    button.disabled = true;
    try {
      if (rejectId) {
        await request(
          `/admin/orders/${rejectId}/reject`,
          jsonBody('POST', { reason: reason.trim() }),
          'Татгалзах үйлдэл амжилтгүй боллоо.'
        );
        showResult($('orders-result'), 'Татгалзлаа. Хэрэглэгч шинэ баримт илгээж болно.');
      } else {
        const paymentId = button.dataset.payment;
        const id = paymentId || button.dataset.purchased;
        const step = paymentId ? 'payment-received' : 'purchased';
        await request(`/admin/orders/${id}/${step}`, { method: 'PUT' }, 'Захиалгын төлөв шинэчлэгдсэнгүй.');
        showResult(
          $('orders-result'),
          paymentId ? 'Төлбөр баталгаажлаа.' : 'Хүргэлт баталгаажлаа. Захиалга дууссан.'
        );
      }
      await loadOrders();
    } catch (error) {
      showResult($('orders-result'), error.message, true);
      button.disabled = false;
    }
  });
}
