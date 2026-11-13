// The top-up panel on the landing page: the public price ladder, and the
// manual-amount row under it.
//
// This is the first thing on this site that quotes a price to a stranger.
// The list is the catalogue's own — what a signed-in customer pays is the
// same figure less whatever their loyalty level discounts, so a public list
// can only ever over-state the bill, never under-state it. The footnote in
// the markup says exactly that.
//
// Nothing here is trusted. The rows are display; the server prices the order
// from its own package row when one is actually created, so a price edited in
// the DOM buys nothing.

import { $, renderLoading, renderEmpty, renderError } from '../common/dom.js';
import { formatMnt, formatNumber } from '../common/format.js';
import { state } from './state.js';

const LADDER_ID = 'topup-ladder';

// Where a press on a price is parked until there is an account to attach it
// to. The OAuth handshake leaves the page, so this has to outlive a
// navigation — sessionStorage does and localStorage would outlive the whole
// visit, which is a stale intent waiting to surprise someone next week.
const INTENT_KEY = 'rbxmn:topup-intent';

export function rememberIntent(intent) {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* Private mode, or storage disabled. The buyer picks again after
       sign-in, which is the behaviour this whole mechanism improves on
       rather than the behaviour it depends on. */
  }
}

export function takeIntent() {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

// What 100 Robux costs inside a package. Not printed anywhere — it was a
// third number under two others and read as clutter — but it still decides
// which row is flagged as the best value, which is the useful half of it.
const unitPrice = (pkg, price) => Math.round((price / pkg.robuxAmount) * 100);

// Cheapest per Robux, computed rather than flagged in admin so it can never
// disagree with the prices beside it. A tie wins nothing: with no discounts
// configured every package costs the same per Robux, and crowning whichever
// one sorted first would be advice the prices do not support.
export function bestValueId(packages) {
  if (packages.length < 2) return null;
  const rates = packages.map((pkg) => unitPrice(pkg, pkg.effectivePriceMnt));
  const cheapest = Math.min(...rates);
  if (rates.filter((rate) => rate === cheapest).length > 1) return null;
  return packages[rates.indexOf(cheapest)].id;
}

/**
 * One row of the ladder, and the only place its markup is written.
 *
 * The workspace's package picker renders the same rows through this function
 * (see packages.js), which is what keeps the price a visitor was shown before
 * signing in identical to the one they are charged after. Two renderers would
 * have drifted the first time either was touched.
 *
 * @param {object} pkg      a row from the public /packages response
 * @param {number} price    what to display, after any level discount
 * @param {object} flags    `picked` for the chosen row, `best` for the flag
 */
function ladderRow(pkg, price, { picked = false, best = false } = {}) {
  const classes = ['topup-row'];
  if (picked) classes.push('is-picked');
  if (best) classes.push('is-best');

  // The discount hangs off the bottom-right of the row rather than taking a
  // column, because a column would render an empty cell on every package that
  // has no discount — a gap where a promise used to be.
  const off = pkg.discountPercent > 0
    ? `<span class="topup-off">${Number(pkg.discountPercent)}% хямдрал</span>`
    : '';

  return `
    <button type="button" class="${classes.join(' ')}" data-package-id="${Number(pkg.id)}"
            aria-pressed="${picked}">
      <span class="topup-price">${formatMnt(price)}</span>
      <span class="topup-robux">
        <svg class="topup-coin" viewBox="0 0 24 24" aria-hidden="true">
          <path class="coin-body" d="M12 2.4l8.3 4.8v9.6L12 21.6 3.7 16.8V7.2z"/>
          <path class="coin-stud" d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z"/>
        </svg>
        ${formatNumber(pkg.robuxAmount)}
      </span>
      ${off}
    </button>`;
}

/**
 * The whole ladder, for either surface.
 *
 * @param {Array}  packages  the catalogue
 * @param {object} options   `pricer` maps a package to its display price;
 *                           `pickedId` marks one row as chosen.
 */
export function ladderMarkup(packages, { pricer = (pkg) => pkg.effectivePriceMnt, pickedId = null } = {}) {
  const best = bestValueId(packages);
  return packages
    .map((pkg) => ladderRow(pkg, pricer(pkg), {
      picked: pkg.id === pickedId,
      best: pkg.id === best
    }))
    .join('');
}

// The landing copy. No level discount is applied here — there is no session
// to read one from, which is the whole reason the footnote under the panel
// exists.
export function renderTopupLadder() {
  const container = $(LADDER_ID);
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

  container.innerHTML = ladderMarkup(state.packages);
}

export function showTopupLoading() {
  const container = $(LADDER_ID);
  if (container && !state.packages.length) renderLoading(container, { rows: 5 });
}

export function showTopupError(retry) {
  const container = $(LADDER_ID);
  if (!container) return;
  renderError(container, {
    title: 'Үнэ ачаалагдсангүй',
    body: 'Багцын мэдээлэл авч чадсангүй. Дахин оролдоно уу.',
    retry,
    inline: true
  });
}

// ---------------------------------------------------------------------------
// The manual amount
// ---------------------------------------------------------------------------

// Which unit the buyer is typing in, or null while the field is closed.
let unit = null;

const UNITS = {
  mnt: {
    button: 'topup-unit-mnt',
    placeholder: '20000',
    // ₮ in, Robux out. Rounded *down*: quoting 213 Robux for a sum that buys
    // 213.4 and then delivering 213 is a promise kept; the other way round is
    // a complaint.
    convert(value) {
      if (!state.pricePer100) return null;
      const robux = Math.floor((value / state.pricePer100) * 100);
      return robux < 1 ? null : `${formatMnt(value)} ≈ <strong>${formatNumber(robux)} Robux</strong>`;
    }
  },
  robux: {
    button: 'topup-unit-robux',
    placeholder: '640',
    convert(value) {
      if (!state.pricePer100) return null;
      const price = Math.round((value / 100) * state.pricePer100);
      return `${formatNumber(value)} Robux ≈ <strong>${formatMnt(price)}</strong>`;
    }
  }
};

function setUnit(next) {
  // Pressing the unit you are already in closes the field. Without that the
  // only way out of a row you opened by accident is a page reload.
  unit = unit === next ? null : next;

  Object.entries(UNITS).forEach(([name, config]) => {
    $(config.button)?.setAttribute('aria-pressed', String(unit === name));
  });

  const entry = $('topup-entry');
  const input = $('topup-amount');
  entry.hidden = !unit;

  if (!unit) {
    $('topup-convert').hidden = true;
    return;
  }

  // The typed figure is deliberately *kept* when the unit changes. Somebody
  // who typed 20000 meaning tugriks and then realises the other button was
  // the one they wanted has not changed their mind about the number.
  input.placeholder = UNITS[unit].placeholder;
  input.focus();
  updateConversion();
}

function updateConversion() {
  const note = $('topup-convert');
  const value = Number($('topup-amount').value);

  if (!unit || !value || value <= 0) {
    note.hidden = true;
    return;
  }

  const text = UNITS[unit].convert(value);
  note.classList.toggle('is-error', !text);
  note.innerHTML = text || 'Ханш ачаалагдаагүй байна. Хуудсаа шинэчилнэ үү.';
  note.hidden = false;
}

// ---------------------------------------------------------------------------

// Both the ladder rows and the manual row end in the same place while there
// is no session: the sign-in card, with what was asked for parked in
// sessionStorage so the Buy tab can honour it on the other side.
function proceed(intent) {
  rememberIntent(intent);
  const card = $('login');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Focus lands on the button rather than the card so a keyboard user arrives
  // on the thing they are meant to press, not on a heading above it.
  $('generate-qr-btn')?.focus({ preventScroll: true });
}

/**
 * The hero character is a slot, and the file behind it may not exist yet.
 *
 * A missing decorative asset must not leave the browser's broken-image glyph
 * sitting in the middle of the hero, and `onerror=""` on the tag itself — the
 * obvious way to say that — is exactly what this page's nonce-based CSP
 * blocks. So the check lives here, and it tests the image's *state* as well
 * as listening for the event: a 404 can land before this module has finished
 * importing, and a listener attached after the fact never hears it.
 */
function initHeroCharacter() {
  const layer = document.querySelector('.hero-character');
  const img = layer?.querySelector('img');
  if (!layer || !img) return;

  const drop = () => layer.remove();
  img.addEventListener('error', drop);
  if (img.complete && img.naturalWidth === 0) drop();
}

export function initTopup() {
  initHeroCharacter();

  const ladder = $(LADDER_ID);
  if (!ladder) return;

  ladder.addEventListener('click', (event) => {
    const row = event.target.closest('.topup-row');
    if (!row) return;
    proceed({ kind: 'package', packageId: Number(row.dataset.packageId) });
  });

  Object.entries(UNITS).forEach(([name, config]) => {
    $(config.button)?.addEventListener('click', () => setUnit(name));
  });

  $('topup-amount')?.addEventListener('input', updateConversion);

  $('topup-go')?.addEventListener('click', () => {
    const value = Number($('topup-amount').value);
    if (!unit || !value || value <= 0) {
      $('topup-amount')?.focus();
      return;
    }
    proceed({ kind: 'manual', unit, value });
  });

  // Enter in the field is the same press as the button beside it.
  $('topup-amount')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('topup-go')?.click();
    }
  });
}
