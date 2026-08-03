// The referral programme: global rates, per-creator overrides, and recording
// commission that has actually been paid out.

import { $, escapeHtml, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatNumber } from '../common/format.js';
import { openDialog, askNote } from './dialog.js';
import { loadAuditLog } from './audit.js';

export async function loadReferralSettings() {
  try {
    const { settings } = await request('/admin/referrals/settings', undefined, 'Урилгын тохиргоог авч чадсангүй.');
    $('referral-enabled').checked = settings.enabled;
    $('referral-bonus-percent').value = settings.bonusPercent;
    $('referral-commission-percent').value = settings.commissionPercent;
    $('referral-bonus-scope').value = settings.bonusScope;
    $('referral-max-bonus').value = settings.maxBonusRobux;
    $('referral-min-payout').value = settings.minPayoutRobux;
    $('referral-new-only').checked = settings.newCustomersOnly;
  } catch (error) {
    showResult($('referral-settings-result'), error.message, true);
  }
}

export async function loadReferralCodes() {
  try {
    const data = await request('/admin/referrals/codes', undefined, 'Кодуудыг авч чадсангүй.');
    if (!data.codes.length) {
      $('referral-codes-list').innerHTML = '<p class="hint">Одоогоор урилгын код үүсээгүй байна.</p>';
      return;
    }

    $('referral-codes-list').innerHTML = data.codes.map((code) => `
      <div class="editable-row referral-row${code.isInfluencer ? ' is-influencer' : ''}">
        <div>
          <strong>${escapeHtml(code.code)}${code.isInfluencer ? ' <span class="badge badge-active">Бүтээгч</span>' : ''}${code.isActive ? '' : ' <span class="badge badge-danger">Идэвхгүй</span>'}</strong>
          <small>${escapeHtml(code.ownerUsername)} · ${formatNumber(code.referredUsers)} хэрэглэгч · ${formatNumber(code.completedOrders)} дууссан захиалга</small>
          <small>Борлуулалт: ${formatNumber(code.drivenRobux)} R$ · Олсон: ${formatNumber(code.earnedRobux)} R$ · Төлсөн: ${formatNumber(code.paidOutRobux)} R$</small>
          <small class="referral-balance">Үлдэгдэл: <strong>${formatNumber(code.balanceRobux)} R$</strong></small>
        </div>
        <div class="referral-controls">
          <label class="checkbox-row"><input type="checkbox" data-influencer="${Number(code.id)}" ${code.isInfluencer ? 'checked' : ''}> Бүтээгч</label>
          <label class="checkbox-row"><input type="checkbox" data-active="${Number(code.id)}" ${code.isActive ? 'checked' : ''}> Идэвхтэй</label>
          <input type="number" class="mini-input" data-bonus="${Number(code.id)}" min="0" max="50" step="0.5"
                 value="${code.bonusPercentOverride ?? ''}" placeholder="${Number(data.defaultBonusPercent)}% (ерөнхий)" title="Урамшуулал %">
          <input type="number" class="mini-input" data-commission="${Number(code.id)}" min="0" max="50" step="0.5"
                 value="${code.commissionPercentOverride ?? ''}" placeholder="${Number(data.defaultCommissionPercent)}% (ерөнхий)" title="Шимтгэл %">
          <button class="btn btn-sm" type="button" data-save-referral="${Number(code.id)}">Хадгалах</button>
          ${code.balanceRobux > 0
            ? `<button class="btn btn-sm btn-ghost" type="button" data-payout="${Number(code.id)}" data-balance="${Number(code.balanceRobux)}">Төлөлт бүртгэх</button>`
            : ''}
        </div>
      </div>`).join('');
  } catch (error) {
    showResult($('referral-codes-result'), error.message, true);
  }
}

async function saveCodeTerms(button) {
  const id = button.dataset.saveReferral;
  const bonus = document.querySelector(`[data-bonus="${id}"]`).value;
  const commission = document.querySelector(`[data-commission="${id}"]`).value;

  button.disabled = true;
  try {
    await request(`/admin/referrals/codes/${id}`, jsonBody('PUT', {
      isInfluencer: document.querySelector(`[data-influencer="${id}"]`).checked,
      isActive: document.querySelector(`[data-active="${id}"]`).checked,
      // Empty means "no override" — the global rate applies.
      bonusPercentOverride: bonus === '' ? null : Number(bonus),
      commissionPercentOverride: commission === '' ? null : Number(commission)
    }), 'Нөхцөлийг шинэчилж чадсангүй.');
    showResult($('referral-codes-result'), 'Кодын нөхцөл шинэчлэгдлээ.');
    await loadReferralCodes();
  } catch (error) {
    showResult($('referral-codes-result'), error.message, true);
    button.disabled = false;
  }
}

// Records Robux already handed over. The server refuses anything above the
// outstanding balance as well — the validation here is only so the admin is
// told before the round trip.
async function recordPayout(button) {
  const id = button.dataset.payout;
  const balance = Number(button.dataset.balance);

  const entered = await openDialog({
    title: 'Шимтгэл төлсөн',
    message: `Аваагүй үлдэгдэл: ${formatNumber(balance)} R$.`,
    input: {
      label: 'Хэдэн Robux төлсөн бэ?',
      type: 'number',
      value: String(balance),
      hint: 'Үлдэгдлээс хэтрэхгүй, эерэг бүхэл тоо.'
    },
    confirmLabel: 'Төлсөн гэж бүртгэх',
    validate: (value) => {
      const amount = Number(value);
      if (!Number.isInteger(amount) || amount < 1) return 'Эерэг бүхэл тоо оруулна уу.';
      if (amount > balance) return `Үлдэгдлээс (${formatNumber(balance)} R$) хэтэрч байна.`;
      return null;
    }
  });
  if (entered === null) return;

  const note = await askNote('Заавал биш.', 'Жишээ: Группээр шилжүүлсэн');

  button.disabled = true;
  try {
    const data = await request(
      `/admin/referrals/codes/${id}/payout`,
      jsonBody('POST', { robuxAmount: Number(entered), note }),
      'Төлөлтийг бүртгэж чадсангүй.'
    );
    showResult($('referral-codes-result'), data.message);
    await Promise.all([loadReferralCodes(), loadAuditLog()]);
  } catch (error) {
    showResult($('referral-codes-result'), error.message, true);
    button.disabled = false;
  }
}

export function initReferrals() {
  $('save-referral-settings').addEventListener('click', async () => {
    const button = $('save-referral-settings');
    setLoading(button, true, 'Хадгалж байна…');
    try {
      const data = await request('/admin/referrals/settings', jsonBody('PUT', {
        enabled: $('referral-enabled').checked,
        bonusPercent: Number($('referral-bonus-percent').value),
        commissionPercent: Number($('referral-commission-percent').value),
        bonusScope: $('referral-bonus-scope').value,
        maxBonusRobux: Number($('referral-max-bonus').value),
        minPayoutRobux: Number($('referral-min-payout').value),
        newCustomersOnly: $('referral-new-only').checked
      }), 'Тохиргоог хадгалж чадсангүй.');
      showResult($('referral-settings-result'), data.message);
      await Promise.all([loadReferralSettings(), loadReferralCodes()]);
    } catch (error) {
      showResult($('referral-settings-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('referral-codes-list').addEventListener('click', async (event) => {
    const saveButton = event.target.closest('[data-save-referral]');
    if (saveButton) {
      await saveCodeTerms(saveButton);
      return;
    }
    const payoutButton = event.target.closest('[data-payout]');
    if (payoutButton) await recordPayout(payoutButton);
  });
}
