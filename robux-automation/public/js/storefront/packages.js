// The fixed Robux packages a customer can buy, and the live rate the rest of
// the storefront prices against.
//
// One picker now, not two: gift cards left the fixed catalogue and take a
// typed amount instead, so this is only the Buy tab's picker — see
// gift-cards.js.
//
// Prices rendered here are display-only. The server prices the order from its
// own package row when one is actually created, so a tampered price in the
// DOM buys nothing.

import { $, renderLoading, renderEmpty, renderError } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber, animateNumber } from '../common/format.js';
import { state } from './state.js';

// The one picker a signed-in customer chooses from, and the only place
// package prices are shown at all. The landing page no longer carries a
// public price list: what a customer actually pays depends on their loyalty
// level, so the one list a stranger could be shown is the one nobody is
// charged.
const PICKER_ID = 'order-package-picker';

function displayPrice(pkg) {
  return Math.round(pkg.effectivePriceMnt * (1 - state.levelDiscountPercent / 100));
}

// What 100 Robux costs inside this package. No longer printed on the tile —
// it was a third number under two others and read as clutter. It still
// decides which package is flagged as the best value, which is the useful
// half of it: the comparison without the arithmetic on screen.
const unitPrice = (pkg, price) => Math.round((price / pkg.robuxAmount) * 100);

// Cheapest per Robux — the answer to "which one should I buy?". Computed
// rather than flagged in admin so it can never disagree with the prices
// beside it.
//
// A tie wins nothing. With no discounts configured every package costs the
// same per Robux, and crowning whichever one sorted first would be advice
// the prices do not support.
function bestValueId(packages) {
  if (packages.length < 2) return null;
  const rates = packages.map((pkg) => unitPrice(pkg, pkg.effectivePriceMnt));
  const cheapest = Math.min(...rates);
  if (rates.filter((rate) => rate === cheapest).length > 1) return null;
  return packages[rates.indexOf(cheapest)].id;
}

// A native <select>, not a custom listbox. It is the platform control for
// "pick exactly one of these", which means the keyboard handling, the
// type-ahead, the touch pickers on iOS and Android and the screen-reader
// announcement all arrive for free and correct — where the grid it replaced
// had to hand-roll roving tabindex and arrow keys to get halfway there.
//
// Each option has to carry on one line what a tile carried in four corners,
// so it reads amount, then price, then the discount if there is one. What
// will not fit — the per-100 rate, the best-value flag — moves to the summary
// under the control, where it describes the current choice instead of every
// choice at once.
export function refreshPackagePicker() {
  const container = $(PICKER_ID);
  if (!container) return;
  if (!state.packages.length) {
    renderEmpty(container, {
      icon: '◇',
      title: 'Багц алга',
      body: 'Одоогоор худалдаанд гарсан багц байхгүй байна.',
      inline: true
    });
    return;
  }

  const best = bestValueId(state.packages);
  const options = state.packages.map((pkg) => {
    const price = displayPrice(pkg);
    const parts = [`${formatNumber(pkg.robuxAmount)} Robux`, formatMnt(price)];
    if (pkg.discountPercent > 0) parts.push(`-${Number(pkg.discountPercent)}%`);
    // The best-value flag rides in the option itself, not in the summary
    // below. In the summary it would only appear once you had already picked
    // the right package, which is advice arriving after the decision — the
    // tile grid showed it on all options at once, and that is the half of it
    // worth keeping.
    if (pkg.id === best) parts.push('Ашигтай');
    return `<option value="${Number(pkg.id)}"${pkg.id === state.selectedOrderPackageId ? ' selected' : ''}>`
      + `${parts.join('  ·  ')}</option>`;
  }).join('');

  const selected = state.packages.find((pkg) => pkg.id === state.selectedOrderPackageId);
  container.innerHTML = `
    <select class="package-select" id="order-package-select">${options}</select>
    <p class="package-summary" id="order-package-summary">${summaryFor(selected)}</p>`;

  updateOrderTotalDisplay();
}

// The fact the tiles showed that an <option> has no room for. The unit rate
// is what makes a bigger package legible as better value rather than merely
// more expensive, and that argument is worth keeping on screen — but only for
// the package actually chosen, which is what a summary line is for.
function summaryFor(pkg) {
  if (!pkg) return '';
  return `100 Robux тутам ${formatMnt(unitPrice(pkg, displayPrice(pkg)))}`;
}

function selectPackage(id) {
  state.selectedOrderPackageId = id;
  // Only the summary and the total change — re-rendering the <select> itself
  // while it is open or focused would close the native picker and drop focus.
  const summary = $('order-package-summary');
  if (summary) {
    summary.textContent = summaryFor(state.packages.find((pkg) => pkg.id === id));
  }
  updateOrderTotalDisplay();
}

export function updateOrderTotalDisplay() {
  const pkg = state.packages.find((item) => item.id === state.selectedOrderPackageId);
  if (!pkg) return;
  animateNumber($('order-total'), displayPrice(pkg), formatMnt);
}

export async function loadPackages() {
  if (!state.packages.length) renderLoading($(PICKER_ID), { rows: 1 });

  try {
    const data = await request('/packages');
    state.packages = data.packages;
    if (!state.packages.some((pkg) => pkg.id === state.selectedOrderPackageId)) {
      state.selectedOrderPackageId = state.packages[Math.min(1, state.packages.length - 1)]?.id ?? null;
    }
    refreshPackagePicker();
  } catch {
    renderError($(PICKER_ID), {
      title: 'Багцууд ачаалагдсангүй',
      body: 'Үнийн мэдээлэл авч чадсангүй. Дахин оролдоно уу.',
      retry: loadPackages,
      inline: true
    });
  }
}

/**
 * The rate per 100 Robux. Nothing renders it on its own any more — the
 * workspace header used to carry it as a pill, which quoted a headline price
 * nobody is actually charged — but the gift card quote is computed from it,
 * so it is still fetched and parked on the state.
 */
export async function loadPricing() {
  try {
    const data = await request('/pricing');
    state.pricePer100 = Number(data.pricePer100) || 0;
  } catch {
    state.pricePer100 = 0;
  }
}

// One delegated `change`, and that is the whole interaction model — the
// arrow-key handling the grid needed is the browser's job now.
export function initPackages() {
  document.addEventListener('change', (event) => {
    if (!event.target.matches('.package-select')) return;
    selectPackage(Number(event.target.value));
  });
}
