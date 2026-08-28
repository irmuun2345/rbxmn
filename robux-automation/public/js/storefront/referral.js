// The referral programme: claiming a code, applying someone else's, and the
// earnings summary.

import {
  $, showResult, setLoading, renderLoading, renderEmpty, renderError
} from '../common/dom.js';
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

  // Codes are issued by an admin, never claimed here — so this form stays
  // hidden whether or not the user already owns a code.
  $('referral-create-form').hidden = true;

  if (data.myCode) {
    $('referral-code-display').hidden = false;
    $('referral-my-code').textContent = data.myCode.code;
    $('referral-bonus-display').textContent = `+${data.myCode.bonusPercent}% Robux`;
    $('referral-commission-display').textContent = `${data.myCode.commissionPercent}% Robux`;

    // remainingUses is null for an uncapped code — 0 remaining and no limit
    // at all are opposite states, so they must not both read as "0".
    const { maxUses, usedCount, remainingUses } = data.myCode;
    $('referral-uses-display').textContent = remainingUses === null
      ? 'Хязгааргүй'
      : (remainingUses === 0
        ? `Дууссан (${formatNumber(maxUses)}/${formatNumber(maxUses)})`
        : `${formatNumber(usedCount)}/${formatNumber(maxUses)} · ${formatNumber(remainingUses)} үлдсэн`);

    // Five figures in a column of label/value rows read as a form, not as
    // earnings. The balance is the one anyone opens this tab for, so it gets
    // a tile of its own and the other four share the grid below it.
    const stats = data.myCode.stats;
    $('referral-stats').innerHTML = `
      <div class="stat-hero">
        <span class="stat-hero-label">Аваагүй үлдэгдэл</span>
        <strong class="stat-hero-value tabular">${formatNumber(stats.balanceRobux)} Robux</strong>
        ${stats.balanceRobux < data.minPayoutRobux
          ? `<span class="stat-hero-note">${formatNumber(data.minPayoutRobux)} Robux цугларахад төлөгдөнө</span>`
          : '<span class="stat-hero-note">Төлөгдөх боломжтой</span>'}
      </div>
      <div class="stat-grid">
        <div class="stat-tile">
          <span class="stat-tile-value tabular">${formatNumber(stats.referredUsers)}</span>
          <span class="stat-tile-label">Урьсан хүн</span>
        </div>
        <div class="stat-tile">
          <span class="stat-tile-value tabular">${formatNumber(stats.completedOrders)}</span>
          <span class="stat-tile-label">Дууссан захиалга</span>
        </div>
        <div class="stat-tile">
          <span class="stat-tile-value tabular">${formatNumber(stats.pendingOrders)}</span>
          <span class="stat-tile-label">Хүлээгдэж буй</span>
        </div>
        <div class="stat-tile">
          <span class="stat-tile-value tabular">${formatNumber(stats.earnedRobux)}</span>
          <span class="stat-tile-label">Нийт олсон Robux</span>
        </div>
      </div>
      ${stats.pendingRobux
        ? `<p class="hint">${formatNumber(stats.pendingRobux)} Robux нь хүргэгдээгүй захиалгад хамаарна. Захиалга дуусмагц тооцогдоно.</p>`
        : ''}`;
  } else {
    $('referral-code-display').hidden = true;
    renderEmpty($('referral-stats'), {
      icon: '◇',
      title: 'Танд урилгын код алга',
      body: `Урилгын кодыг админ олгодог. Код авбал найзуудынхаа дууссан захиалга бүрээс ${Number(data.commissionPercent)}% Robux авна. Код авахыг хүсвэл тусламжаар холбогдоно уу.`,
      inline: true
    });
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
  renderLoading($('referral-stats'), { rows: 2 });
  try {
    renderReferral(await request('/referral/me'));
  } catch {
    // The code panel beside this one still explains the programme, so the
    // failure is reported where the figures would have been rather than
    // taking over the whole tab.
    renderError($('referral-stats'), {
      title: 'Орлогын мэдээлэл ачаалагдсангүй',
      retry: loadReferral,
      inline: true
    });
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
