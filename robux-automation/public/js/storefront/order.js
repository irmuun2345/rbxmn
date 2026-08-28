// Placing an order and following it to delivery: the payment panel, the
// receipt upload, and the status poll that drives the stepper.
//
// The status vocabulary this reads from lives in order-status-view.js, which
// the history list shares — see the note at the top of that file.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt, formatNumber } from '../common/format.js';
import { state } from './state.js';
import { orderBlockedReason } from './fulfilment.js';
import { loadProfile, renderLevel } from './profile.js';
import { renderBankAccounts } from './bank-accounts.js';
import { statusView, CAN_UPLOAD_RECEIPT } from './order-status-view.js';
import { selectTab } from './tabs.js';

// Set by main.js once orders.js is initialised. A plain import would be a
// cycle — orders.js already imports resumeOrder from here — and this module
// must keep working if the history panel is not on the page at all.
let refreshHistory = () => {};

export function onOrderChanged(callback) {
  refreshHistory = callback;
}

export function stopPaymentPolling() {
  if (state.paymentPollTimer) clearTimeout(state.paymentPollTimer);
  state.paymentPollTimer = null;
}

function setStepper(stepNumber) {
  document.querySelectorAll('.stepper-item').forEach((item) => {
    const step = Number(item.dataset.step);
    item.classList.toggle('is-done', step < stepNumber);
    item.classList.toggle('is-active', step === stepNumber);
    item.querySelector('.stepper-dot').textContent = step < stepNumber ? '✓' : String(step);
  });
}

// The upload box is only useful while the buyer still owes us a receipt.
function setReceiptUploadVisible(visible) {
  const box = $('receipt-upload');
  if (box) box.hidden = !visible;
}

// Event and referral bonuses are separate promises, so both are named rather
// than merged into one opaque "+15%".
function renderBonusNote(data) {
  const parts = [];
  if (data.bonusPercent > 0) {
    parts.push(`${data.eventName || 'Эвент'} +${data.bonusPercent}%`);
  }
  if (data.referralBonusPercent > 0) {
    parts.push(data.referralCode
      ? `Урилга (${data.referralCode}) +${data.referralBonusPercent}%`
      : `Урилга +${data.referralBonusPercent}%`);
  }

  $('bonus-note').hidden = !parts.length;
  if (!parts.length) return;
  $('bonus-note').textContent = `🎉 ${parts.join(' · ')} · ${formatNumber(data.deliveredRobux)} Robux хүргэгдэнэ`;
}

function showPaymentPanel(data) {
  $('create-form').hidden = true;
  state.orderId = data.orderId;
  renderBankAccounts($('bank-list'), data.banks, 'bank');
  $('payment-reference').textContent = data.paymentReference;
  $('payment-amount').textContent = formatMnt(data.amountMnt);

  const view = statusView(data.status || 'awaiting_payment');
  $('payment-status').className = `badge ${view.badge}`;
  $('payment-status').textContent = view.label;

  renderBonusNote(data);

  setStepper(view.step);
  // A resumed order may already be past the upload stage.
  setReceiptUploadVisible(CAN_UPLOAD_RECEIPT.includes(data.status || 'awaiting_payment'));
  $('receipt-result').hidden = true;
  $('payment-result').hidden = true;
  $('payment-panel').hidden = false;
  $('payment-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  pollPaymentStatus(data.orderId, data.status || 'awaiting_payment');
}

/**
 * Reopens an order the buyer left unfinished, straight into the panel it was
 * abandoned from. The bank list is refetched rather than remembered: an admin
 * may have changed which accounts are live since the order was placed, and
 * paying into a retired account is the one mistake this flow cannot undo.
 *
 * @param {object} row a game_passes row as /profile returns it
 */
export async function resumeOrder(row) {
  selectTab('buy');
  try {
    const { accounts } = await request('/bank-account');
    showPaymentPanel({
      orderId: row.id,
      banks: accounts,
      paymentReference: row.payment_reference,
      amountMnt: row.amount_mnt,
      status: row.status,
      bonusPercent: row.bonus_percent,
      referralBonusPercent: row.referral_bonus_percent,
      deliveredRobux: row.delivered_robux || row.price,
      requestedRobux: row.price
    });
  } catch (error) {
    showResult($('create-result'), error.message, true);
  }
}

async function pollPaymentStatus(orderId, lastStatus) {
  stopPaymentPolling();
  try {
    const data = await request('/profile');
    const order = data.gamePasses.find((gamePass) => gamePass.id === orderId);
    const status = order?.status || lastStatus;
    const view = statusView(status);

    if (status !== lastStatus) {
      $('payment-status').className = `badge ${view.badge}`;
      $('payment-status').textContent = view.label;
      setStepper(view.step);
      setReceiptUploadVisible(CAN_UPLOAD_RECEIPT.includes(status));
      // The history list is showing this same order; it must not still be
      // claiming the old status while the panel above it shows the new one.
      refreshHistory();

      if (status === 'payment_rejected') {
        // A rejection isn't the end — the buyer can send a corrected receipt
        // against the same order, so keep the upload open.
        showResult(
          $('payment-result'),
          order?.rejection_reason
            ? `Төлбөр татгалзсан: ${order.rejection_reason}. Зөв баримтаа дахин илгээнэ үү.`
            : 'Төлбөр татгалзсан. Зөв баримтаа дахин илгээнэ үү.',
          true
        );
      } else if (view.note) {
        showResult($('payment-result'), view.note, status === 'failed');
      }
    }

    if (view.terminal) {
      // The level ring can only have moved on a completed order, and the
      // response already in hand carries it — no second round trip.
      if (status === 'completed' && data.level) renderLevel(data.level);
      return;
    }

    state.paymentPollTimer = setTimeout(() => pollPaymentStatus(orderId, status), 4000);
  } catch {
    state.paymentPollTimer = setTimeout(() => pollPaymentStatus(orderId, lastStatus), 5000);
  }
}

// Puts the panel back to its pre-order state. Called on logout, and by the
// "place another order" button once one has finished.
export function resetOrderPanel() {
  stopPaymentPolling();
  state.orderId = null;
  $('create-form').hidden = false;
  $('payment-panel').hidden = true;
  $('create-result').hidden = true;
}

function initReceiptUpload() {
  // The native input is visually hidden behind a styled label, so the chosen
  // filename has to be echoed back — otherwise there is no confirmation that
  // the pick registered at all.
  $('receipt-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    $('receipt-file-name').textContent = file ? file.name : 'Файл сонгоогүй байна';
  });

  $('receipt-submit').addEventListener('click', async () => {
    const button = $('receipt-submit');
    const input = $('receipt-file');
    const file = input.files && input.files[0];

    if (!state.orderId) {
      showResult($('receipt-result'), 'Идэвхтэй захиалга олдсонгүй.', true);
      return;
    }
    if (!file) {
      showResult($('receipt-result'), 'Баримтын файлаа сонгоно уу.', true);
      return;
    }

    setLoading(button, true, 'Илгээж байна…');
    try {
      const body = new FormData();
      body.append('receipt', file);
      // No Content-Type header here on purpose — the browser has to set the
      // multipart boundary itself, so jsonBody() must not be used.
      const data = await request(
        `/orders/${state.orderId}/receipt`,
        { method: 'POST', body },
        'Баримт илгээгдсэнгүй.'
      );

      showResult($('receipt-result'), data.message);
      input.value = '';
      $('receipt-file-name').textContent = 'Файл сонгоогүй байна';
      setReceiptUploadVisible(false);
      refreshHistory();
      pollPaymentStatus(state.orderId, 'awaiting_payment');
    } catch (error) {
      showResult($('receipt-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}

export function initOrder() {
  initReceiptUpload();

  // Leaves the finished order alone in the history and gives the buyer the
  // form back. Without it the only way to place a second order was a reload.
  $('new-order-btn')?.addEventListener('click', () => {
    resetOrderPanel();
    $('create-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('create-order-btn').addEventListener('click', async () => {
    const button = $('create-order-btn');

    // The button was left enabled precisely so it can explain itself here.
    const blocked = orderBlockedReason();
    if (blocked) {
      showResult($('create-result'), blocked, true);
      return;
    }

    if (!state.selectedOrderPackageId) {
      showResult($('create-result'), 'Robux багц сонгоно уу.', true);
      return;
    }

    let url;
    const body = { packageId: state.selectedOrderPackageId };
    if (state.method === 'group') {
      url = '/create-group-order';
    } else {
      // Name and description are the server's to generate. universeId is only
      // sent when the buyer actually had a choice to make.
      url = '/create-gamepass';
      if (state.authorizedUniverseIds.length > 1) body.universeId = $('gamepass-universe').value;
    }

    setLoading(button, true, 'Үүсгэж байна…');
    try {
      const data = await request(
        url,
        jsonBody('POST', body),
        'Захиалга үүсгэж чадсангүй. Мэдээллээ шалгана уу.'
      );
      showPaymentPanel(data);
      loadProfile();
      refreshHistory();
    } catch (error) {
      showResult($('create-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}
