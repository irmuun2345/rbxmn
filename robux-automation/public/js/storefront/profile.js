// The account panel in the header: who is signed in, and the loyalty level
// ring.
//
// The level is computed server-side from delivered orders and only rendered
// here — there is no client path that can raise it.

import { $, escapeHtml } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatNumber } from '../common/format.js';
import { state } from './state.js';
import { refreshPackageGrids } from './packages.js';

// Circumference of the r=26 circle in the level ring, so the dash offset can
// be driven as a fraction of it.
const LEVEL_RING_CIRCUMFERENCE = 163.36;

export function renderLevel(level) {
  const { totalPurchasedRobux, level: currentLevel, nextThreshold, threshold, discountPercent } = level;
  $('level-title').textContent = `Түвшин ${currentLevel}${discountPercent ? ` · -${discountPercent}%` : ''}`;
  $('level-ring-label').textContent = currentLevel;
  $('account-level').textContent = currentLevel;

  if (nextThreshold) {
    $('level-progress').textContent = `${formatNumber(totalPurchasedRobux)} / ${formatNumber(nextThreshold)} R$`;
    const base = threshold || 0;
    const progress = Math.min(1, (totalPurchasedRobux - base) / (nextThreshold - base));
    $('level-ring-fill').style.strokeDashoffset = String(LEVEL_RING_CIRCUMFERENCE * (1 - progress));
  } else {
    $('level-progress').textContent = `${formatNumber(totalPurchasedRobux)} R$ · Дээд түвшин`;
    $('level-ring-fill').style.strokeDashoffset = '0';
  }

  // A changed discount moves every displayed price, so the grids are redrawn
  // — but only when it actually changed.
  if (state.levelDiscountPercent !== (discountPercent || 0)) {
    state.levelDiscountPercent = discountPercent || 0;
    refreshPackageGrids();
  }
}

export async function loadProfile() {
  try {
    const data = await request('/profile');
    $('profile-info').innerHTML = `
      <div class="profile-row"><span>Хэрэглэгч</span><strong>${escapeHtml(data.user.username)}</strong></div>
      <div class="profile-row"><span>Roblox ID</span><strong>${Number(data.user.robloxId) || 'Хүлээгдэж байна'}</strong></div>
      <div class="profile-row"><span>Захиалга</span><strong>${data.gamePasses.length}</strong></div>`;
    $('account-name').textContent = data.user.username;
    renderLevel(data.level);
  } catch {
    $('profile-info').innerHTML = '<p class="hint">Аккаунтын мэдээлэл одоогоор авах боломжгүй байна.</p>';
  }
}
