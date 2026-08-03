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

function renderOrders(orders) {
  const countOf = (statuses) => orders.filter((order) => statuses.includes(order.status)).length;
  $('payment-orders').textContent = countOf(PENDING_REVIEW);
  $('ready-orders').textContent = countOf(IN_DELIVERY);
  $('purchased-orders').textContent = countOf(['completed']);

  if (!orders.length) {
    $('orders-list').innerHTML = '<tr><td class="empty-cell" colspan="6">Одоогоор захиалга алга.</td></tr>';
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
          <strong>${formatNumber(order.price)} R$</strong>
          <small>${isGroup ? 'Группээр' : `Pass: ${formatNumber(order.listed_price)} R$`}</small>
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
    renderOrders(data.orders);
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
