// The buyer's own purchase history: orders and gift cards, one list.
//
// Until now the storefront could only ever show one order: the one being
// placed right now. Everything before it existed in the database, was
// returned by /profile on every single request, and was rendered nowhere —
// so "did my transfer from Tuesday go through?" had no answer on the site,
// and an order interrupted by a closed tab was unreachable even though the
// payment reference was still valid.
//
// Gift cards had the opposite problem: their own small list, in their own
// tab, showing the same four facts in a different shape. They are purchases
// paid for the same way and waiting on the same admin, so they are rows here
// now and the gift tab is just the form and the redeem box.
//
// This module fetches both, renders them as one list, filters it by what
// state things are in, and opens any row into its full record.

import { $, escapeHtml, renderLoading, renderEmpty, renderError } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber, formatStoredDateTime } from '../common/format.js';
import { state } from './state.js';
import { statusView, giftStatusView, isOpen, bucketFor, ORDER_FILTERS } from './order-status-view.js';
import { openOrderDetail } from './order-detail.js';

// How many rows are shown before "show more". Six is about a screenful on a
// phone, and most customers have fewer than that in total.
const PAGE_SIZE = 6;

let activeFilter = 'all';
let shown = PAGE_SIZE;

// No delivery-route label. Which pipe the Robux arrive down — the group, a
// game pass — is our plumbing, and naming it on a receipt tells a customer
// about infrastructure they have no use for and we would rather not publish.
// fulfilment.js has kept this rule since the routes were added; the history
// row was briefly the one place that broke it.

/* ============================================================
   Normalising

   Two tables with two vocabularies land in one list, so each is flattened
   into the same handful of fields first. Everything downstream — the rows,
   the chips, the tab count, the detail dialog — reads only these, and none
   of it has to know which table a row came from.
   ============================================================ */

function fromOrder(row) {
  const view = statusView(row.status);
  const robux = Number(row.delivered_robux || row.price || 0);
  const requested = Number(row.price || 0);

  return {
    key: `order-${row.id}`,
    kind: 'order',
    id: Number(row.id),
    robux,
    bonusRobux: robux > requested ? robux - requested : 0,
    amountMnt: Number(row.amount_mnt || 0),
    status: row.status,
    view,
    bucket: bucketFor(view, { failed: row.status === 'failed' }),
    reference: row.payment_reference || null,
    createdAt: row.created_at,
    // Only shown while it is still the live explanation: a reason left on a
    // since-approved order would read as a rejection that never lifted.
    rejectionReason: row.status === 'payment_rejected' ? row.rejection_reason || null : null,
    code: null,
    // Reopening the payment panel only makes sense while there is a payment
    // left to make against a reference that still exists.
    resumable: isOpen(row.status) && Boolean(row.payment_reference),
    raw: row
  };
}

function fromGiftCard(card) {
  // A rejected receipt does not move a gift card out of awaiting_payment — it
  // only writes a reason onto it. Without surfacing that, a buyer sees a card
  // stuck on "waiting for payment" days after they paid, and no explanation.
  const rejected = Boolean(card.rejectionReason);
  const view = rejected
    ? { label: 'Баримт татгалзсан', badge: 'badge-danger', tone: 'danger', actionable: true }
    : giftStatusView(card.status);

  return {
    key: `gift-${card.id}`,
    kind: 'gift',
    id: Number(card.id),
    robux: Number(card.robuxAmount || 0),
    bonusRobux: 0,
    amountMnt: Number(card.amountMnt || 0),
    status: card.status,
    view,
    bucket: bucketFor(view),
    // The reference stops being the useful half once the card is paid for and
    // the code has taken its place.
    reference: card.code ? null : card.paymentReference || null,
    createdAt: card.createdAt,
    rejectionReason: card.rejectionReason || null,
    code: card.code || null,
    resumable: false,
    raw: card
  };
}

// Newest first. The two APIs each return their own insertion order, which is
// the least useful order for a list whose top row is the one you are waiting
// on — and merging two of those would be no order at all.
const byNewest = (a, b) =>
  new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || b.key.localeCompare(a.key);

const matches = (entry, filterId) => filterId === 'all' || entry.bucket === filterId;

// The count that rides on the tab, and the reason the tab is worth opening:
// rows where the money is waiting on the *buyer*, not on us.
export function actionableCount() {
  return state.orders.filter((entry) => entry.view.actionable).length;
}

// Every row is a button now. It used to be a button only when the order could
// be resumed, on the principle that a cursor should not promise an action
// that does not exist — but there is always an action: the record itself.
function entryRow(entry) {
  return `
    <button class="data-row${entry.view.actionable ? ' is-actionable' : ''}"
            type="button" data-entry-key="${escapeHtml(entry.key)}"
            data-tone="${escapeHtml(entry.view.tone)}">
      <span class="data-row-main">
        <span class="data-row-title">
          ${formatNumber(entry.robux)} Robux
          ${entry.code || entry.reference
            ? `<span class="ref-code">${escapeHtml(entry.code || entry.reference)}</span>`
            : ''}
        </span>
        <span class="data-row-meta">
          <span>${escapeHtml(formatStoredDateTime(entry.createdAt))}</span>
          ${entry.kind === 'gift' ? '<span class="sep">·</span><span>Бэлгийн карт</span>' : ''}
          ${entry.bonusRobux
            ? `<span class="sep">·</span><span>+${formatNumber(entry.bonusRobux)} Robux бонус</span>`
            : ''}
        </span>
      </span>
      <span class="data-row-side">
        <span class="data-row-amount">${formatMnt(entry.amountMnt)}</span>
        <span class="badge ${escapeHtml(entry.view.badge)}">${escapeHtml(entry.view.label)}</span>
      </span>
      ${entry.rejectionReason
        ? `<span class="data-row-note">Татгалзсан шалтгаан: ${escapeHtml(entry.rejectionReason)}</span>`
        : ''}
      <span class="sr-only">Дэлгэрэнгүй харах</span>
    </button>`;
}

function renderChips() {
  const container = $('order-filters');
  if (!container) return;

  container.innerHTML = ORDER_FILTERS.map((filter) => {
    const count = state.orders.filter((entry) => matches(entry, filter.id)).length;
    const selected = filter.id === activeFilter;
    return `
      <button class="chip" type="button" role="radio" data-order-filter="${filter.id}"
              aria-checked="${selected}" tabindex="${selected ? 0 : -1}"
              ${count ? '' : 'disabled'}>
        ${escapeHtml(filter.label)}
        <span class="chip-count">${count}</span>
      </button>`;
  }).join('');
}

function renderList() {
  const list = $('orders-list');
  if (!list) return;

  const visible = state.orders.filter((entry) => matches(entry, activeFilter));
  const page = visible.slice(0, shown);

  $('orders-summary').innerHTML = visible.length
    ? `<strong>${page.length}</strong> / ${visible.length} захиалга`
    : '';

  if (!state.orders.length) {
    renderEmpty(list, {
      icon: '◇',
      title: 'Захиалга алга',
      body: 'Robux авах хэсгээс эхний захиалгаа үүсгэнэ үү. Захиалга, бэлгийн карт бүр энд, төлөвийнхөө хамт хадгалагдана.'
    });
    return;
  }

  // The list is not empty, this *filter* is. Different problem, different
  // way out: clear the filter rather than go and place an order.
  if (!visible.length) {
    renderEmpty(list, {
      icon: '⌕',
      title: 'Энэ ангилалд захиалга алга',
      body: 'Өөр ангилал сонгох эсвэл бүх захиалгаа харна уу.',
      inline: true,
      action: { label: 'Бүгдийг харах', onClick: () => setFilter('all') }
    });
    return;
  }

  list.innerHTML = `
    <div class="data-list">${page.map(entryRow).join('')}</div>
    ${visible.length > page.length
      ? `<div class="list-more">
           <button class="btn btn-ghost btn-sm" type="button" data-orders-more>
             Цааш нь харах (${visible.length - page.length})
           </button>
         </div>`
      : ''}`;
}

function render() {
  renderChips();
  renderList();

  const count = actionableCount();
  const pill = $('tab-orders-count');
  if (pill) {
    pill.hidden = !count;
    pill.textContent = String(count);
  }
}

function setFilter(id) {
  activeFilter = id;
  shown = PAGE_SIZE;
  render();
}

/**
 * Fetches both halves of the history and redraws. Safe to call as often as
 * anything changes: /profile is the same request the account panel already
 * makes, and the gift card list is a handful of the buyer's own rows.
 *
 * The gift cards are best-effort. If that request fails the orders still
 * render — half a history is worth a great deal more than an error page
 * where a history used to be.
 *
 * @param {{silent?: boolean}} [options] silent skips the skeleton, for the
 *   background refreshes that follow a poll — a list that flashes back to
 *   grey bars every four seconds is worse than one that updates in place.
 */
export async function loadOrders({ silent = false } = {}) {
  const list = $('orders-list');
  if (!list) return;
  if (!silent && !state.orders.length) renderLoading(list, { rows: 3 });

  try {
    const [profile, gifts] = await Promise.all([
      request('/profile'),
      request('/gift-cards/mine').catch(() => null)
    ]);

    state.orders = [
      ...(profile.gamePasses || []).map(fromOrder),
      ...(gifts?.giftCards || []).map(fromGiftCard)
    ].sort(byNewest);
    render();
  } catch {
    if (state.orders.length) return; // keep what is on screen; it is still true
    renderError(list, {
      title: 'Захиалгуудыг ачаалж чадсангүй',
      body: 'Холболтоо шалгаад дахин оролдоно уу.',
      retry: () => loadOrders()
    });
  }
}

export function resetOrders() {
  state.orders = [];
  activeFilter = 'all';
  shown = PAGE_SIZE;
}

export function initOrders() {
  const panel = $('panel-orders');
  if (!panel) return;

  panel.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-order-filter]');
    if (chip) {
      setFilter(chip.dataset.orderFilter);
      $('order-filters')?.querySelector('[aria-checked="true"]')?.focus();
      return;
    }

    if (event.target.closest('[data-orders-more]')) {
      shown += PAGE_SIZE;
      renderList();
      return;
    }

    const row = event.target.closest('[data-entry-key]');
    if (!row) return;
    const entry = state.orders.find((candidate) => candidate.key === row.dataset.entryKey);
    if (entry) openOrderDetail(entry);
  });

  // Arrow keys across the filter chips, which are a radiogroup and so must be
  // a single tab stop with the arrows moving inside it.
  panel.addEventListener('keydown', (event) => {
    const chip = event.target.closest('[data-order-filter]');
    if (!chip) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;

    event.preventDefault();
    const chips = [...panel.querySelectorAll('[data-order-filter]:not(:disabled)')];
    const next = chips[(chips.indexOf(chip) + step + chips.length) % chips.length];
    if (next) {
      setFilter(next.dataset.orderFilter);
      $('order-filters')?.querySelector('[aria-checked="true"]')?.focus();
    }
  });
}
