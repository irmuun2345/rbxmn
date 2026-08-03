// Placing an order and following it to delivery: the payment panel, the
// receipt upload, and the status poll that drives the stepper.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt, formatNumber } from '../common/format.js';
import { state } from './state.js';
import { orderBlockedReason } from './fulfilment.js';
import { loadProfile, renderLevel } from './profile.js';

// Mirrors src/services/order-status.js. Each entry drives the badge, the
// stepper position, and the explanatory line under the payment panel.
const ORDER_STATUS_VIEW = {
  requested:               { label: 'Захиалга үүссэн',          badge: 'badge-pending', step: 2 },
  awaiting_payment:        { label: 'Төлбөр хүлээж байна',      badge: 'badge-pending', step: 2 },
  payment_submitted:       { label: 'Баримт илгээгдсэн',        badge: 'badge-pending', step: 3,
    note: 'Баримт хүлээн авлаа. Админ шалгаж байна.' },
  under_review:            { label: 'Шалгаж байна',             badge: 'badge-pending', step: 3,
    note: 'Админ таны баримтыг шалгаж байна.' },
  payment_approved:        { label: 'Төлбөр баталгаажсан',      badge: 'badge-active',  step: 4,
    note: 'Админ таны төлбөрийг баталгаажууллаа. Хүргэлтэд бэлтгэж байна.' },
  payment_rejected:        { label: 'Төлбөр татгалзсан',        badge: 'badge-danger',  step: 2, terminal: false },
  fulfillment_pending:     { label: 'Хүргэлт хүлээгдэж байна',  badge: 'badge-active',  step: 4,
    note: 'Төлбөр баталгаажлаа. Таны Robux удахгүй хүргэгдэнэ.' },
  fulfillment_processing:  { label: 'Хүргэлт явагдаж байна',    badge: 'badge-active',  step: 4,
    note: 'Robux хүргэх үйлдэл явагдаж байна.' },
  completed:               { label: 'Дууссан',                  badge: 'badge-active',  step: 5, terminal: true,
    note: 'Таны Robux амжилттай хүргэгдлээ. Баярлалаа!' },
  failed:                  { label: 'Амжилтгүй',                badge: 'badge-danger',  step: 4, terminal: true,
    note: 'Хүргэлт амжилтгүй боллоо. Админтай холбогдоно уу.' }
};

// The states in which the buyer still owes us a receipt.
const CAN_UPLOAD_RECEIPT = ['awaiting_payment', 'payment_rejected'];

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

function showPaymentPanel(data) {
  $('create-form').hidden = true;
  state.orderId = data.orderId;
  $('bank-name').textContent = data.bank?.name || 'Тохируулаагүй';
  $('bank-account').textContent = data.bank?.accountNumber || 'Тохируулаагүй';
  $('bank-holder').textContent = data.bank?.accountHolder || 'Тохируулаагүй';
  $('payment-reference').textContent = data.paymentReference;
  $('payment-amount').textContent = formatMnt(data.amountMnt);
  $('payment-status').className = 'badge badge-pending';
  $('payment-status').innerHTML = '<i class="dot"></i>Төлбөр хүлээж байна';

  // Event and referral bonuses are separate promises, so both are named
  // rather than merged into one opaque "+15%".
  const bonusParts = [];
  if (data.bonusPercent > 0) {
    bonusParts.push(`${data.eventName || 'Эвент'} +${data.bonusPercent}%`);
  }
  if (data.referralBonusPercent > 0) {
    bonusParts.push(`Урилга (${data.referralCode}) +${data.referralBonusPercent}%`);
  }
  if (bonusParts.length) {
    $('bonus-note').hidden = false;
    $('bonus-note').textContent = `🎉 ${bonusParts.join(' · ')} — ${formatNumber(data.deliveredRobux)} R$ `
      + `хүргэгдэнэ (${formatNumber(data.requestedRobux)} R$-ний оронд)`;
  } else {
    $('bonus-note').hidden = true;
  }

  setStepper(2);
  // A resumed order may already be past the upload stage.
  setReceiptUploadVisible(!data.status || CAN_UPLOAD_RECEIPT.includes(data.status));
  $('receipt-result').hidden = true;
  $('payment-panel').hidden = false;
  $('payment-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  pollPaymentStatus(data.orderId, data.status || 'awaiting_payment');
}

async function pollPaymentStatus(orderId, lastStatus) {
  stopPaymentPolling();
  try {
    const data = await request('/profile');
    const order = data.gamePasses.find((gamePass) => gamePass.id === orderId);
    const status = order?.status || lastStatus;
    const view = ORDER_STATUS_VIEW[status];

    if (view && status !== lastStatus) {
      $('payment-status').className = `badge ${view.badge}`;
      $('payment-status').textContent = view.label;
      setStepper(view.step);
      setReceiptUploadVisible(CAN_UPLOAD_RECEIPT.includes(status));

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

    if (view?.terminal) {
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

// Puts the panel back to its pre-order state. Called on logout.
export function resetOrderPanel() {
  stopPaymentPolling();
  state.orderId = null;
  $('create-form').hidden = false;
  $('payment-panel').hidden = true;
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

  $('create-order-btn').addEventListener('click', async () => {
    const button = $('create-order-btn');

    // The button was left enabled precisely so it can explain itself here.
    const blocked = orderBlockedReason();
    if (blocked) {
      showResult($('create-result'), blocked, true);
      if (!state.authorizedUniverseIds.length) {
        $('route-unlock').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
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
    } catch (error) {
      showResult($('create-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}
