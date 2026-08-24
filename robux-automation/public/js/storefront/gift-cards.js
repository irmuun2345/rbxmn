// Buying a gift card, and redeeming one someone shared with you.

import { $, escapeHtml, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt, formatNumber } from '../common/format.js';
import { state } from './state.js';
import { loadProfile } from './profile.js';
import { renderBankAccounts } from './bank-accounts.js';

function statusLabel(status) {
  if (status === 'awaiting_payment') return 'Төлбөр хүлээж байна';
  if (status === 'approved') return 'Ашиглах боломжтой';
  if (status === 'redeemed') return 'Ашигласан';
  return status;
}

export async function loadMyGiftCards() {
  const list = $('my-giftcards-list');
  try {
    const data = await request('/gift-cards/mine');
    if (!data.giftCards.length) {
      list.innerHTML = '<p class="hint">Одоогоор бэлгийн карт алга.</p>';
      return;
    }
    list.innerHTML = data.giftCards.map((card) => `
      <div class="editable-row">
        <div>
          <strong>${formatNumber(card.robuxAmount)} R$</strong>
          <small>${formatMnt(card.amountMnt)} · ${escapeHtml(statusLabel(card.status))}</small>
        </div>
        ${card.code
          ? `<span class="ref-code">${escapeHtml(card.code)}</span>`
          : '<span class="badge badge-pending">Хүлээгдэж байна</span>'}
      </div>`).join('');
  } catch {
    list.innerHTML = '<p class="hint">Бэлгийн картуудыг ачаалж чадсангүй.</p>';
  }
}

export function initGiftCards() {
  $('create-giftcard-btn').addEventListener('click', async () => {
    const button = $('create-giftcard-btn');
    if (!state.selectedGiftPackageId) {
      showResult($('giftcard-create-result'), 'Бэлгийн картын багц сонгоно уу.', true);
      return;
    }
    setLoading(button, true, 'Үүсгэж байна…');
    try {
      const data = await request(
        '/create-gift-card',
        jsonBody('POST', { packageId: state.selectedGiftPackageId }),
        'Бэлгийн карт үүсгэж чадсангүй.'
      );
      $('giftcard-create-form').hidden = true;
      renderBankAccounts($('giftcard-bank-list'), data.banks, 'giftcard-bank');
      $('giftcard-payment-reference').textContent = data.paymentReference;
      $('giftcard-payment-amount').textContent = formatMnt(data.amountMnt);
      $('giftcard-payment-panel').hidden = false;
      showResult($('giftcard-create-result'), 'Бэлгийн картын захиалга үүслээ. Төлбөрөө шилжүүлнэ үү.');
      loadMyGiftCards();
    } catch (error) {
      showResult($('giftcard-create-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('redeem-giftcard-btn').addEventListener('click', async () => {
    const button = $('redeem-giftcard-btn');
    const code = $('redeem-code-input').value.trim();
    if (!code) {
      showResult($('redeem-result'), 'Бэлгийн картын кодоо оруулна уу.', true);
      return;
    }
    setLoading(button, true, 'Ашиглаж байна…');
    try {
      const data = await request(
        '/gift-cards/redeem',
        jsonBody('POST', { code }),
        'Бэлгийн картыг ашиглаж чадсангүй.'
      );
      $('redeem-code-input').value = '';
      showResult($('redeem-result'), data.message);
      loadProfile();
    } catch (error) {
      showResult($('redeem-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}
