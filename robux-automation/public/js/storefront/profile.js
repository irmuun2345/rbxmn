// The account panel in the header: who is signed in, and the loyalty level
// ring.
//
// The level is computed server-side from delivered orders and only rendered
// here — there is no client path that can raise it.

import { $, escapeHtml, renderLoading, renderError } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatNumber } from '../common/format.js';
import { state } from './state.js';
import { refreshPackagePicker } from './packages.js';

// Circumference of the r=26 circle in the level ring, so the dash offset can
// be driven as a fraction of it.
const LEVEL_RING_CIRCUMFERENCE = 163.36;

export function renderLevel(level) {
  const { totalPurchasedRobux, level: currentLevel, nextThreshold, threshold, discountPercent } = level;
  $('level-title').textContent = `Түвшин ${currentLevel}${discountPercent ? ` · -${discountPercent}%` : ''}`;
  $('level-ring-label').textContent = currentLevel;
  $('account-level').textContent = currentLevel;

  if (nextThreshold) {
    $('level-progress').textContent = `${formatNumber(totalPurchasedRobux)} / ${formatNumber(nextThreshold)} Robux`;
    const base = threshold || 0;
    const progress = Math.min(1, (totalPurchasedRobux - base) / (nextThreshold - base));
    $('level-ring-fill').style.strokeDashoffset = String(LEVEL_RING_CIRCUMFERENCE * (1 - progress));
  } else {
    $('level-progress').textContent = `${formatNumber(totalPurchasedRobux)} Robux · Дээд түвшин`;
    $('level-ring-fill').style.strokeDashoffset = '0';
  }

  // A changed discount moves every displayed price, so the grids are redrawn
  // — but only when it actually changed.
  if (state.levelDiscountPercent !== (discountPercent || 0)) {
    state.levelDiscountPercent = discountPercent || 0;
    refreshPackagePicker();
  }
}

export async function loadProfile() {
  renderLoading($('profile-info'), { rows: 3 });
  try {
    const data = await request('/profile');
    const orders = data.gamePasses || [];
    const delivered = orders
      .filter((order) => order.status === 'completed')
      .reduce((total, order) => total + Number(order.delivered_robux || order.price || 0), 0);

    $('profile-info').innerHTML = `
      <div class="profile-row"><span>Хэрэглэгч</span><strong>${escapeHtml(data.user.username)}</strong></div>
      <div class="profile-row"><span>Roblox ID</span><strong>${Number(data.user.robloxId) || 'Хүлээгдэж байна'}</strong></div>
      <div class="profile-row"><span>Захиалга</span><strong>${formatNumber(orders.length)}</strong></div>
      <div class="profile-row"><span>Хүргэгдсэн</span><strong>${formatNumber(delivered)} Robux</strong></div>`;
    $('account-name').textContent = data.user.username;
    renderLevel(data.level);
  } catch {
    renderError($('profile-info'), {
      title: 'Мэдээлэл авч чадсангүй',
      body: 'Аккаунтын мэдээлэл одоогоор авах боломжгүй байна.',
      retry: loadProfile,
      inline: true
    });
  }
}
