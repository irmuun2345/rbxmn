// The fixed Robux packages a customer can buy, and the live rate the rest of
// the storefront prices against.
//
// One picker now, not two: gift cards left the fixed catalogue and take a
// typed amount instead, so this is only the Buy tab's picker — see
// gift-cards.js.
//
// The picker draws the same ladder the landing page carries. It used to be a
// native <select>, chosen because "pick exactly one of these" is what a
// select is for — and that was right while the catalogue was a list of
// options nobody had seen before. It is not right now: a visitor arrives here
// having already read the prices as a ladder on the way in, and handing them
// a collapsed dropdown at the moment of purchase hides the comparison they
// made their decision with. Same rows, same order, same markup builder —
// see topup.js — so the two surfaces cannot drift apart.
//
// Prices rendered here are display-only. The server prices the order from its
// own package row when one is actually created, so a tampered price in the
// DOM buys nothing.

import { $, renderLoading, renderEmpty, renderError } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, animateNumber } from '../common/format.js';
import { state } from './state.js';
import {
  ladderMarkup, bestValueId, renderTopupLadder, showTopupLoading, showTopupError, takeIntent
} from './topup.js';

const PICKER_ID = 'order-package-picker';

// What this customer actually pays: the catalogue price less whatever their
// loyalty level discounts. The landing ladder shows the undiscounted figure,
// which is why the panel there carries a footnote saying so.
function displayPrice(pkg) {
  return Math.round(pkg.effectivePriceMnt * (1 - state.levelDiscountPercent / 100));
}

const unitPrice = (pkg, price) => Math.round((price / pkg.robuxAmount) * 100);

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

  const selected = state.packages.find((pkg) => pkg.id === state.selectedOrderPackageId);
  container.innerHTML = `
    <div class="topup-ladder">
      ${ladderMarkup(state.packages, {
        pricer: displayPrice,
        pickedId: state.selectedOrderPackageId
      })}
    </div>
    <p class="package-summary" id="order-package-summary">${summaryFor(selected)}</p>`;

  updateOrderTotalDisplay();
}

// The fact a row has no room for: what 100 Robux costs inside the package
// actually chosen. It is what makes a bigger package legible as better value
// rather than merely more expensive, and it belongs to the selection rather
// than to the catalogue — which is why it is a line under the ladder and not
// a third column inside it.
function summaryFor(pkg) {
  if (!pkg) return '';
  return `100 Robux тутам ${formatMnt(unitPrice(pkg, displayPrice(pkg)))}`;
}

function selectPackage(id) {
  if (!state.packages.some((pkg) => pkg.id === id)) return;
  state.selectedOrderPackageId = id;

  // Only the pressed row, its former neighbour and the summary change. A full
  // re-render would rebuild the ladder under the pointer that just pressed it
  // and throw away keyboard focus with it.
  const container = $(PICKER_ID);
  const best = bestValueId(state.packages);
  container?.querySelectorAll('.topup-row').forEach((row) => {
    const picked = Number(row.dataset.packageId) === id;
    row.classList.toggle('is-picked', picked);
    row.classList.toggle('is-best', Number(row.dataset.packageId) === best);
    row.setAttribute('aria-pressed', String(picked));
  });

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

/**
 * Honour whatever the visitor pressed on the landing page before they had an
 * account to press it with.
 *
 * A package intent names a row outright. A manual intent named an amount the
 * catalogue does not sell, so it resolves to the nearest package that is at
 * least as large — rounding *down* would hand someone less Robux than the
 * figure they typed and confirmed, which is the one outcome worth avoiding.
 * Falling back to the largest package when they asked for more than is sold
 * keeps the tab from opening on an empty selection.
 */
function resolveIntent(intent) {
  if (!intent || !state.packages.length) return null;

  if (intent.kind === 'package') {
    return state.packages.some((pkg) => pkg.id === intent.packageId) ? intent.packageId : null;
  }

  if (intent.kind !== 'manual') return null;

  const wanted = intent.unit === 'robux'
    ? intent.value
    : (state.pricePer100 ? (intent.value / state.pricePer100) * 100 : 0);
  if (!wanted) return null;

  const sorted = [...state.packages].sort((a, b) => a.robuxAmount - b.robuxAmount);
  const atLeast = sorted.find((pkg) => pkg.robuxAmount >= wanted);
  return (atLeast || sorted[sorted.length - 1]).id;
}

export async function loadPackages() {
  if (!state.packages.length) renderLoading($(PICKER_ID), { rows: 1 });
  showTopupLoading();

  try {
    const data = await request('/packages');
    state.packages = data.packages;

    // Whatever was pressed on the way in wins over the default, and it is
    // consumed as it is read — a stale intent should not reassert itself the
    // next time the catalogue refreshes.
    const intended = resolveIntent(takeIntent());
    if (intended) {
      state.selectedOrderPackageId = intended;
    } else if (!state.packages.some((pkg) => pkg.id === state.selectedOrderPackageId)) {
      state.selectedOrderPackageId = state.packages[Math.min(1, state.packages.length - 1)]?.id ?? null;
    }

    refreshPackagePicker();
    renderTopupLadder();
  } catch {
    renderError($(PICKER_ID), {
      title: 'Багцууд ачаалагдсангүй',
      body: 'Үнийн мэдээлэл авч чадсангүй. Дахин оролдоно уу.',
      retry: loadPackages,
      inline: true
    });
    showTopupError(loadPackages);
  }
}

/**
 * The rate per 100 Robux. The gift card quote and the landing page's manual
 * amount converter are both computed from it; nothing renders it on its own.
 */
export async function loadPricing() {
  try {
    const data = await request('/pricing');
    state.pricePer100 = Number(data.pricePer100) || 0;
  } catch {
    state.pricePer100 = 0;
  }
}

// One delegated `click` on the picker, and that is the whole interaction
// model. The rows are real <button>s, so Enter, Space and the focus ring all
// arrive from the platform exactly as they did from the <select>.
export function initPackages() {
  $(PICKER_ID)?.addEventListener('click', (event) => {
    const row = event.target.closest('.topup-row');
    if (!row) return;
    selectPackage(Number(row.dataset.packageId));
  });
}
