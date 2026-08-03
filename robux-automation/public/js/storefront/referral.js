// The referral programme: claiming a code, applying someone else's, and the
// earnings summary.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatNumber } from '../common/format.js';
import { currentTab, selectTab } from './tabs.js';

// Mirrors the server rule exactly: 3-8 characters, letters and digits only.
// Enforced here purely so the user gets told before submitting — the server
// validates independently and is the only check that counts.
const CODE_PATTERN = /^[A-Z0-9]{3,8}$/;
const INVALID_CODE_MESSAGE = 'Код 3-8 тэмдэгт, зөвхөн үсэг болон тоо байна.';

let availabilityTimer = null;

// Strip anything the rules don't allow as the user types, rather than
// rejecting on submit — it makes the constraint obvious immediately.
function normaliseCodeInput(input) {
  input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function renderReferral(data) {
  // The programme can be switched off entirely in admin, in which case the
  // tab has nothing to show at all.
  $('tab-referral').hidden = !data.enabled;
  if (!data.enabled && currentTab() === 'referral') selectTab('buy');

  if (data.myCode) {
    $('referral-create-form').hidden = true;
    $('referral-code-display').hidden = false;
    $('referral-my-code').textContent = data.myCode.code;
    $('referral-bonus-display').textContent = `+${data.myCode.bonusPercent}% Robux`;
    $('referral-commission-display').textContent = `${data.myCode.commissionPercent}% Robux`;

    const stats = data.myCode.stats;
    $('referral-stats').innerHTML = `
      <div class="line-item"><span>Урьсан хүн</span><strong>${formatNumber(stats.referredUsers)}</strong></div>
      <div class="line-item"><span>Дууссан захиалга</span><strong>${formatNumber(stats.completedOrders)}</strong></div>
      <div class="line-item"><span>Хүлээгдэж буй</span><strong>${formatNumber(stats.pendingOrders)}</strong></div>
      <div class="line-item"><span>Олсон Robux</span><strong>${formatNumber(stats.earnedRobux)} R$</strong></div>
      <div class="line-item"><span>Аваагүй үлдэгдэл</span><strong>${formatNumber(stats.balanceRobux)} R$</strong></div>
      ${stats.pendingRobux
        ? `<p class="hint">${formatNumber(stats.pendingRobux)} R$ нь хүргэгдээгүй захиалгад хамаарна. Захиалга дуусмагц тооцогдоно.</p>`
        : ''}
      ${stats.balanceRobux < data.minPayoutRobux
        ? `<p class="hint">Хамгийн багадаа ${formatNumber(data.minPayoutRobux)} R$ цугларахад төлөгдөнө.</p>`
        : ''}`;
  } else {
    $('referral-create-form').hidden = false;
    $('referral-code-display').hidden = true;
    $('referral-stats').innerHTML = '<p class="hint">Кодоо үүсгээд найз нартаа хуваалцвал дууссан '
      + `захиалга бүрээс ${Number(data.commissionPercent)}% Robux авна.</p>`;
  }

  // Already bound to someone — the apply form has nothing left to do.
  if (data.referredBy) {
    $('referral-apply-form').hidden = true;
    $('referral-referred-by').hidden = false;
    $('referral-referrer-name').textContent = `${data.referredBy.username} (${data.referredBy.code})`;
  } else {
    $('referral-apply-form').hidden = false;
    $('referral-referred-by').hidden = true;
  }
}

export async function loadReferral() {
  try {
    renderReferral(await request('/referral/me'));
  } catch {
    /* leave the tab as-is; the gate copy already explains itself */
  }
}

function initAvailabilityCheck() {
  $('referral-code-input').addEventListener('input', (event) => {
    normaliseCodeInput(event.target);
    const code = event.target.value;
    const note = $('referral-code-availability');

    clearTimeout(availabilityTimer);
    if (code.length < 3) {
      note.textContent = code.length ? 'Дор хаяж 3 тэмдэгт.' : '';
      note.className = 'hint';
      return;
    }

    // Debounced: this fires on every keystroke otherwise.
    availabilityTimer = setTimeout(async () => {
      try {
        // A rejected code still answers success:true with `available: false`
        // and its own explanation; only a server fault throws.
        const data = await request(`/referral/available/${encodeURIComponent(code)}`);
        note.textContent = data.available
          ? `"${code}" боломжтой байна.`
          : (data.error || `"${code}" аль хэдийн эзэмшигдсэн байна.`);
        note.className = data.available ? 'hint hint-ok' : 'hint hint-bad';
      } catch {
        // Cleared rather than left alone: a stale "available" sitting next to
        // a code it was not about is worse than saying nothing.
        note.textContent = '';
        note.className = 'hint';
      }
    }, 350);
  });

  $('referral-apply-input').addEventListener('input', (event) => normaliseCodeInput(event.target));
}

export function initReferral() {
  initAvailabilityCheck();

  $('create-referral-btn').addEventListener('click', async () => {
    const button = $('create-referral-btn');
    const code = $('referral-code-input').value;

    if (!CODE_PATTERN.test(code)) {
      showResult($('referral-create-result'), INVALID_CODE_MESSAGE, true);
      return;
    }

    setLoading(button, true, 'Үүсгэж байна…');
    try {
      const data = await request('/referral/code', jsonBody('POST', { code }), 'Код үүсгэж чадсангүй.');
      showResult($('referral-create-result'), data.message);
      $('referral-code-input').value = '';
      $('referral-code-availability').textContent = '';
      await loadReferral();
    } catch (error) {
      showResult($('referral-create-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('apply-referral-btn').addEventListener('click', async () => {
    const button = $('apply-referral-btn');
    const code = $('referral-apply-input').value;

    if (!CODE_PATTERN.test(code)) {
      showResult($('referral-apply-result'), INVALID_CODE_MESSAGE, true);
      return;
    }

    setLoading(button, true, 'Идэвхжүүлж байна…');
    try {
      const data = await request('/referral/apply', jsonBody('POST', { code }), 'Кодыг идэвхжүүлж чадсангүй.');
      showResult($('referral-apply-result'), data.message);
      $('referral-apply-input').value = '';
      await loadReferral();
    } catch (error) {
      showResult($('referral-apply-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}
