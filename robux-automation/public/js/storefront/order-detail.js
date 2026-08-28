// One purchase, opened out of the history list.
//
// Every row in Захиалгууд used to be a dead end unless it was still unpaid:
// only an unfinished order was clickable, and clicking it jumped straight
// into the payment panel. A completed order, a rejected one, a gift card
// waiting on a code — all of them were records the buyer could see a badge
// for and nothing else, even though the reference they paid against and the
// code they bought were sitting right there in the response.
//
// So every row opens this instead: the whole record, plus whatever action is
// still open on it. Resuming a payment is now one button inside the dialog
// rather than the only thing a click could mean.

import { $, escapeHtml } from '../common/dom.js';
import { formatMnt, formatNumber, formatStoredDateTime } from '../common/format.js';
import { resumeOrder } from './order.js';
import { resumeGiftCard } from './gift-cards.js';

// The entry whose action button is on screen. Held rather than closed over so
// the listener can be bound once, at init, instead of per open.
let openEntry = null;

const KIND_LABEL = { order: 'Захиалга', gift: 'Бэлгийн карт' };

function field(label, value, { mono = false, copyId = null } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const valueMarkup = copyId
    ? `<span class="${mono ? 'tabular' : ''}" id="${escapeHtml(copyId)}">${escapeHtml(value)}</span>
       <button class="btn btn-ghost btn-sm" type="button" data-copy-target="${escapeHtml(copyId)}">Хуулах</button>`
    : escapeHtml(value);

  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd class="${mono && !copyId ? 'tabular' : ''}">${valueMarkup}</dd>
    </div>`;
}

// What is still worth doing with this row, if anything. Both cases hand off
// to the panel that already knows how to draw the payment leg, rather than
// this dialog growing a second copy of it.
function actionFor(entry) {
  if (entry.kind === 'order' && entry.resumable) {
    return { label: 'Захиалгыг үргэлжлүүлэх', run: () => resumeOrder(entry.raw) };
  }
  if (entry.kind === 'gift' && entry.status === 'awaiting_payment') {
    return { label: 'Төлбөрийн мэдээлэл харах', run: () => resumeGiftCard(entry.raw) };
  }
  return null;
}

export function openOrderDetail(entry) {
  const dialog = $('order-detail');
  if (!dialog) return;
  openEntry = entry;

  $('order-detail-kind').textContent = KIND_LABEL[entry.kind] || 'Захиалга';
  $('order-detail-title').textContent = `${formatNumber(entry.robux)} Robux`;
  $('order-detail-status').className = `badge ${entry.view.badge}`;
  $('order-detail-status').textContent = entry.view.label;

  // A rejection reason is an admin-written sentence aimed at this buyer, so
  // it outranks the generic status note whenever there is one.
  const note = entry.rejectionReason
    ? `Татгалзсан шалтгаан: ${entry.rejectionReason}`
    : entry.view.note || '';
  const noteEl = $('order-detail-note');
  noteEl.hidden = !note;
  noteEl.textContent = note;
  noteEl.dataset.tone = entry.rejectionReason || entry.view.tone === 'danger' ? 'danger' : '';

  $('order-detail-list').innerHTML = [
    field('Огноо', entry.createdAt ? formatStoredDateTime(entry.createdAt) : ''),
    field('Дүн', formatMnt(entry.amountMnt), { mono: true }),
    entry.bonusRobux
      ? field('Бонус', `+${formatNumber(entry.bonusRobux)} Robux`, { mono: true })
      : '',
    field('Гүйлгээний утга', entry.reference, { mono: true, copyId: 'order-detail-reference' }),
    field('Бэлгийн картын код', entry.code, { mono: true, copyId: 'order-detail-code' })
  ].join('');

  const action = actionFor(entry);
  const actionButton = $('order-detail-action');
  actionButton.hidden = !action;
  if (action) actionButton.textContent = action.label;

  dialog.showModal();
}

export function initOrderDetail() {
  const dialog = $('order-detail');
  if (!dialog) return;

  $('order-detail-close').addEventListener('click', () => dialog.close());

  $('order-detail-action').addEventListener('click', () => {
    const action = openEntry && actionFor(openEntry);
    // Closed first: both actions switch tabs and scroll, which a modal
    // sitting on top of the page would hide.
    dialog.close();
    action?.run();
  });

  // Clicking the backdrop. <dialog> reports those as clicks on the dialog
  // itself, so anything inside .detail-body is not one.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('close', () => { openEntry = null; });
}
