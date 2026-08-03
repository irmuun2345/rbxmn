// The fixed Robux packages a customer can buy or gift, and the live rate
// shown in the hero.
//
// Prices rendered here are display-only. The server prices the order from its
// own package row when one is actually created, so a tampered price in the
// DOM buys nothing.

import { $ } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber, animateNumber } from '../common/format.js';
import { state } from './state.js';
import { selectTab } from './tabs.js';

const GRID_IDS = ['hero-package-grid', 'order-package-grid', 'giftcard-package-grid'];

function displayPrice(pkg) {
  return Math.round(pkg.effectivePriceMnt * (1 - state.levelDiscountPercent / 100));
}

// Real radio semantics: the container is a radiogroup, so its children have to
// be radios. They were `aria-pressed` toggle buttons, which left screen
// readers announcing a group with no options in it. Roving tabindex keeps the
// group a single tab stop, as the pattern requires.
function renderPackageGrid(containerId, selectedId, kind) {
  const container = $(containerId);
  if (!container) return;
  if (!state.packages.length) {
    container.innerHTML = '<p class="hint">Багц одоогоор алга.</p>';
    return;
  }
  container.innerHTML = state.packages.map((pkg) => {
    const selected = pkg.id === selectedId;
    return `
      <button type="button" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}"
              class="package-option${selected ? ' is-selected' : ''}"
              data-package-id="${Number(pkg.id)}" data-kind="${kind}">
        <strong>${formatNumber(pkg.robuxAmount)} R$</strong>
        <span class="package-price tabular">${formatMnt(displayPrice(pkg))}</span>
        ${pkg.discountPercent > 0 ? `<span class="package-badge">-${Number(pkg.discountPercent)}%</span>` : ''}
      </button>`;
  }).join('');
}

function selectPackage(id, kind) {
  if (kind === 'gift') {
    state.selectedGiftPackageId = id;
  } else {
    state.selectedOrderPackageId = id;
  }
  refreshPackageGrids();
}

export function refreshPackageGrids() {
  renderPackageGrid('hero-package-grid', state.selectedOrderPackageId, 'order');
  renderPackageGrid('order-package-grid', state.selectedOrderPackageId, 'order');
  renderPackageGrid('giftcard-package-grid', state.selectedGiftPackageId, 'gift');
  updateOrderTotalDisplay();
}

export function updateOrderTotalDisplay() {
  const pkg = state.packages.find((item) => item.id === state.selectedOrderPackageId);
  if (!pkg) return;
  animateNumber($('order-total'), displayPrice(pkg), formatMnt);
}

export async function loadPackages() {
  try {
    const data = await request('/packages');
    state.packages = data.packages;
    if (!state.packages.some((pkg) => pkg.id === state.selectedOrderPackageId)) {
      state.selectedOrderPackageId = state.packages[Math.min(1, state.packages.length - 1)]?.id ?? null;
    }
    if (!state.packages.some((pkg) => pkg.id === state.selectedGiftPackageId)) {
      state.selectedGiftPackageId = state.packages[0]?.id ?? null;
    }
    refreshPackageGrids();
  } catch {
    GRID_IDS.forEach((id) => {
      $(id).innerHTML = '<p class="hint">Багцын мэдээлэл ачаалж чадсангүй.</p>';
    });
  }
}

export async function loadPricing() {
  try {
    const data = await request('/pricing');
    animateNumber($('live-rate'), data.pricePer100, formatMnt);
  } catch {
    $('live-rate').textContent = 'Дахин ачаална уу';
  }
}

export function initPackages() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.package-option');
    if (!button) return;
    selectPackage(Number(button.dataset.packageId), button.dataset.kind);
  });

  // Arrow keys move between options within a radiogroup — without this the
  // group is reachable by keyboard but its options are not selectable.
  document.addEventListener('keydown', (event) => {
    const current = event.target.closest('.package-option');
    if (!current) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;

    event.preventDefault();
    const gridId = current.closest('.package-grid').id;
    const options = [...current.closest('.package-grid').querySelectorAll('.package-option')];
    const next = options[(options.indexOf(current) + step + options.length) % options.length];
    selectPackage(Number(next.dataset.packageId), next.dataset.kind);
    // The grid is re-rendered above, so re-find the node before focusing it.
    $(gridId)?.querySelector('[aria-checked="true"]')?.focus();
  });

  // The hero picker used to change nothing visible, which made it read as
  // decorative. It now hands off to whatever the buyer's next step is.
  $('hero-package-cta').addEventListener('click', () => {
    if (!state.isAuthenticated) {
      $('auth-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    selectTab('buy');
    $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
