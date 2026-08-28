// Two support queues that share nothing but their shape: phone links a human
// may need to undo, and gift cards waiting on payment approval.

import { $, escapeHtml, showResult } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt, formatNumber } from '../common/format.js';
import { askRejectionReason } from './dialog.js';

// ---------------------------------------------------------------------------
// Phone links
// ---------------------------------------------------------------------------

export async function loadPhoneLinks() {
  try {
    const data = await request('/admin/phone-links', undefined, 'Утасны холболтуудыг авч чадсангүй.');
    if (!data.links.length) {
      $('phone-links-list').innerHTML = '<p class="hint">Одоогоор холбогдсон утас алга.</p>';
      return;
    }
    $('phone-links-list').innerHTML = data.links.map((link) => `
      <div class="editable-row">
        <div>
          <strong>${escapeHtml(link.username)}</strong>
          <small>Roblox ID ${Number(link.roblox_id)} · ${escapeHtml(link.phone_number)}</small>
        </div>
        <button class="btn btn-danger btn-sm" type="button" data-unlink-phone="${Number(link.user_id)}">Салгах</button>
      </div>`).join('');
  } catch (error) {
    showResult($('phone-links-result'), error.message, true);
  }
}

function initPhoneLinks() {
  $('phone-links-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-unlink-phone]');
    if (!button) return;
    try {
      await request(
        `/admin/phone-links/${button.dataset.unlinkPhone}`,
        { method: 'DELETE' },
        'Утасны холболтыг салгаж чадсангүй.'
      );
      showResult($('phone-links-result'), 'Утасны холболт салгагдлаа.');
      await loadPhoneLinks();
    } catch (error) {
      showResult($('phone-links-result'), error.message, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Gift cards
// ---------------------------------------------------------------------------

function statusLabel(status) {
  if (status === 'awaiting_payment') return 'Төлбөр хүлээж буй';
  if (status === 'approved') return 'Ашиглах боломжтой';
  if (status === 'redeemed') return 'Ашигласан';
  return status;
}

function receiptLink(card) {
  if (!card.receipt_id) return '';
  const url = `/admin/receipts/${Number(card.receipt_id)}`;
  const preview = card.receipt_mime === 'application/pdf'
    ? '<span class="receipt-thumb receipt-thumb-pdf">PDF</span>'
    : `<img class="receipt-thumb" src="${url}" alt="Төлбөрийн баримт" loading="lazy">`;
  return `<a class="receipt-link" href="${url}" target="_blank" rel="noopener noreferrer">${preview}</a>`;
}

function renderGiftCards(giftCards) {
  if (!giftCards.length) {
    $('gift-cards-list').innerHTML = '<p class="hint">Одоогоор бэлгийн карт алга.</p>';
    return;
  }
  $('gift-cards-list').innerHTML = giftCards.map((card) => `
    <div class="editable-row">
      <div>
        <strong>${formatNumber(card.robux_amount)} Robux</strong>
        <small>${escapeHtml(card.purchaser_username)} · ${formatMnt(card.price_mnt)} · ${escapeHtml(statusLabel(card.status))}</small>
        ${card.payment_reference ? `<span class="ref-code">${escapeHtml(card.payment_reference)}</span>` : ''}
        ${card.rejection_reason ? `<small class="reject-reason">${escapeHtml(card.rejection_reason)}</small>` : ''}
      </div>
      <div class="action-buttons">
        ${receiptLink(card)}
        ${card.status === 'awaiting_payment'
          ? `<button class="btn btn-sm" type="button" data-approve-giftcard="${Number(card.id)}">Төлбөр орсон</button>
             <button class="btn btn-sm btn-danger" type="button" data-reject-giftcard="${Number(card.id)}">Татгалзах</button>`
          : `<span class="badge ${card.status === 'approved' ? 'badge-active' : ''}">${escapeHtml(statusLabel(card.status))}</span>`}
      </div>
    </div>`).join('');
}

export async function loadGiftCards() {
  try {
    const data = await request('/admin/gift-cards', undefined, 'Бэлгийн картуудыг авч чадсангүй.');
    renderGiftCards(data.giftCards);
  } catch (error) {
    showResult($('gift-cards-result'), error.message, true);
  }
}

function initGiftCards() {
  $('gift-cards-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-approve-giftcard], [data-reject-giftcard]');
    if (!button) return;

    const rejectId = button.dataset.rejectGiftcard;
    let reason = null;
    if (rejectId) {
      reason = await askRejectionReason({
        title: 'Бэлгийн картыг татгалзах',
        message: 'Худалдан авагч үүнийг харна.',
        placeholder: 'Жишээ: Төлбөр ирээгүй байна'
      });
      if (reason === null) return;
    }

    button.disabled = true;
    try {
      if (rejectId) {
        await request(
          `/admin/gift-cards/${rejectId}/reject`,
          jsonBody('POST', { reason: reason.trim() }),
          'Татгалзах үйлдэл амжилтгүй боллоо.'
        );
        showResult($('gift-cards-result'), 'Бэлгийн картын төлбөрийг татгалзлаа.');
      } else {
        await request(
          `/admin/gift-cards/${button.dataset.approveGiftcard}/approve`,
          { method: 'POST' },
          'Бэлгийн картыг баталгаажуулж чадсангүй.'
        );
        showResult($('gift-cards-result'), 'Бэлгийн картыг баталгаажууллаа.');
      }
      await loadGiftCards();
    } catch (error) {
      showResult($('gift-cards-result'), error.message, true);
      button.disabled = false;
    }
  });
}

export function initSupport() {
  initPhoneLinks();
  initGiftCards();
}
