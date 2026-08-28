// Buying a gift card, and redeeming one someone shared with you.
//
// A gift card is no longer picked off the package shelf the Buy tab sells
// from: what a present is worth is the giver's decision, so the amount is
// typed and the price quoted from the live rate. The quote drawn here is a
// preview only — /create-gift-card recomputes it from settings the browser
// cannot reach, and that is the number the buyer is actually charged.
//
// The buyer's own cards are not listed here either. They are rows in the
// Захиалгууд tab now, next to every other purchase, and the code lives on the
// row's detail view — see orders.js and order-detail.js.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt } from '../common/format.js';
import { state } from './state.js';
import { loadProfile } from './profile.js';
import { renderBankAccounts } from './bank-accounts.js';
import { selectTab } from './tabs.js';

// Mirrors MIN_GIFT_ROBUX/MAX_GIFT_ROBUX in giftcard-controller.js. Kept here
// so the input can say no before a round trip does; the server's copy is the
// one that decides.
export const MIN_GIFT_ROBUX = 100;
export const MAX_GIFT_ROBUX = 1000;

// Set by main.js. Anything that creates a gift card has to redraw the history
// list, which is where gift cards are shown — but orders.js already imports
// this module's sibling, so a plain import back would be a cycle. Same
// arrangement order.js uses for the same reason.
let notifyChanged = () => {};

export function onGiftCardChanged(callback) {
  notifyChanged = callback;
}

/** The amount currently typed, or null when it is not a usable number. */
function typedAmount() {
  const raw = $('giftcard-robux-input')?.value.trim();
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount < MIN_GIFT_ROBUX || amount > MAX_GIFT_ROBUX) return null;
  return amount;
}

/**
 * Redraws the "you will pay" line under the amount box. Exported because the
 * two figures it reads — the rate and the buyer's level discount — arrive
 * from their own requests after this panel has already been drawn.
 */
export function refreshGiftQuote() {
  const quote = $('giftcard-quote');
  if (!quote) return;

  const amount = typedAmount();
  if (!amount || !state.pricePer100) {
    quote.textContent = '—';
    return;
  }
  quote.textContent = formatMnt(
    Math.round((amount / 100) * state.pricePer100 * (1 - state.levelDiscountPercent / 100))
  );
}

/** Puts the gift panel back to its buy-another state. */
export function resetGiftPanel() {
  $('giftcard-create-form').hidden = false;
  $('giftcard-payment-panel').hidden = true;
  $('giftcard-create-result').hidden = true;
}

function showGiftPayment({ banks, paymentReference, amountMnt }) {
  $('giftcard-create-form').hidden = true;
  renderBankAccounts($('giftcard-bank-list'), banks, 'giftcard-bank');
  $('giftcard-payment-reference').textContent = paymentReference;
  $('giftcard-payment-amount').textContent = formatMnt(amountMnt);
  $('giftcard-payment-panel').hidden = false;
}

/**
 * Reopens the transfer details for a gift card left unpaid, from its row in
 * the history. The bank list is refetched rather than remembered, for the
 * same reason resumeOrder refetches it: an admin may have retired the account
 * the card was originally quoted against, and paying into a dead account is
 * the one mistake this flow cannot undo.
 *
 * @param {object} card a gift card as /gift-cards/mine returns it
 */
export async function resumeGiftCard(card) {
  selectTab('gift');
  try {
    const { accounts } = await request('/bank-account');
    showGiftPayment({
      banks: accounts,
      paymentReference: card.paymentReference,
      amountMnt: card.amountMnt
    });
    $('giftcard-payment-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showResult($('giftcard-create-result'), error.message, true);
  }
}

export function initGiftCards() {
  const amountInput = $('giftcard-robux-input');
  amountInput.addEventListener('input', refreshGiftQuote);

  // Leaves the card that was just bought in the history and gives the form
  // back — without it, buying a second card meant reloading the page.
  $('new-giftcard-btn').addEventListener('click', () => {
    resetGiftPanel();
    $('giftcard-create-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('create-giftcard-btn').addEventListener('click', async () => {
    const button = $('create-giftcard-btn');
    const robuxAmount = typedAmount();
    if (!robuxAmount) {
      showResult(
        $('giftcard-create-result'),
        `Бэлгийн картын дүнг ${MIN_GIFT_ROBUX}-аас ${MAX_GIFT_ROBUX} Robux хооронд бүхэл тоогоор оруулна уу.`,
        true
      );
      amountInput.focus();
      return;
    }

    setLoading(button, true, 'Үүсгэж байна…');
    try {
      const data = await request(
        '/create-gift-card',
        jsonBody('POST', { robuxAmount }),
        'Бэлгийн карт үүсгэж чадсангүй.'
      );
      showGiftPayment(data);
      amountInput.value = '';
      refreshGiftQuote();
      showResult($('giftcard-create-result'), 'Бэлгийн картын захиалга үүслээ. Төлбөрөө шилжүүлнэ үү.');
      notifyChanged();
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
      // Redeeming moves the card to "ашигласан" and creates a delivery order:
      // both of them are rows in the history.
      notifyChanged();
    } catch (error) {
      showResult($('redeem-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}
