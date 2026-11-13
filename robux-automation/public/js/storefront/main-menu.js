// The front door's own behaviour: the price ladder and the manual amount.
//
// Everything the page shares with /giftcards, /invite, /faq and /promos — the
// bell, the Login pill, the sign-in sheet, the session check — is in shell.js.
// What is left here is the part only this page has.
//
// Nothing here is trusted. The rows are display; the server prices an order
// from its own package row when one is actually created, so a figure edited in
// the DOM buys nothing.

import { $ } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber } from '../common/format.js';
import { initShell, openAuth } from './shell.js';

const state = {
  packages: [],
  pricePer100: 0,
  unit: null
};

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

const coin = `
  <svg class="mm-coin" viewBox="0 0 24 24" aria-hidden="true">
    <path class="coin-body" d="M12 2.4l8.3 4.8v9.6L12 21.6 3.7 16.8V7.2z"/>
    <path class="coin-stud" d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z"/>
  </svg>`;

function row(pkg) {
  // The comp hangs a discount off the rows that have one and leaves the rest
  // alone, which is the honest shape: an empty cell reading "0% хямдрал" is a
  // promise where there is none.
  const off = pkg.discountPercent > 0
    ? `<span class="mm-off">${Number(pkg.discountPercent)}% хямдрал</span>`
    : '';

  return `
    <button type="button" class="mm-row" data-package-id="${Number(pkg.id)}">
      <span class="mm-price">${formatMnt(pkg.effectivePriceMnt)}</span>
      <span class="mm-robux">${coin}${formatNumber(pkg.robuxAmount)}</span>
      ${off}
    </button>`;
}

function renderLadder() {
  const ladder = $('ladder');
  if (!state.packages.length) {
    ladder.innerHTML = '<p class="mm-ladder-state">Одоогоор худалдаанд гарсан багц алга.</p>';
    return;
  }
  ladder.innerHTML = state.packages.map(row).join('');
}

function renderLadderLoading() {
  $('ladder').innerHTML = '<div class="mm-skeleton"></div>'.repeat(6);
}

function renderLadderError() {
  $('ladder').innerHTML = `
    <p class="mm-ladder-state">Үнэ ачаалагдсангүй.<br>
      <button type="button" id="ladder-retry">Дахин оролдох</button>
    </p>`;
  $('ladder-retry').addEventListener('click', loadPackages);
}

async function loadPackages() {
  renderLadderLoading();
  try {
    const data = await request('/packages');
    state.packages = data.packages || [];
    renderLadder();
  } catch {
    renderLadderError();
  }
}

// Only the rate, and only for the manual row's live conversion — no price on
// this page is computed from it.
async function loadPricing() {
  try {
    const data = await request('/pricing');
    state.pricePer100 = Number(data.pricePer100) || 0;
  } catch {
    state.pricePer100 = 0;
  }
}

// ---------------------------------------------------------------------------
// The manual amount
// ---------------------------------------------------------------------------

const UNITS = {
  mnt: {
    button: 'unit-mnt',
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
    button: 'unit-robux',
    placeholder: '640',
    convert(value) {
      if (!state.pricePer100) return null;
      return `${formatNumber(value)} Robux ≈ <strong>${formatMnt(Math.round((value / 100) * state.pricePer100))}</strong>`;
    }
  }
};

function setUnit(next) {
  // Pressing the unit you are already in closes the field. Without that the
  // only way out of a row opened by accident is a page reload.
  state.unit = state.unit === next ? null : next;

  Object.entries(UNITS).forEach(([name, config]) => {
    $(config.button).setAttribute('aria-pressed', String(state.unit === name));
  });

  $('entry').hidden = !state.unit;
  if (!state.unit) {
    $('convert').hidden = true;
    return;
  }

  // The typed figure is deliberately kept when the unit changes. Somebody who
  // typed 20000 meaning tugriks and then realises the other button was the
  // one they wanted has not changed their mind about the number.
  $('amount').placeholder = UNITS[state.unit].placeholder;
  $('amount').focus();
  updateConversion();
}

function updateConversion() {
  const note = $('convert');
  const value = Number($('amount').value);

  if (!state.unit || !value || value <= 0) {
    note.hidden = true;
    return;
  }

  const text = UNITS[state.unit].convert(value);
  note.classList.toggle('is-error', !text);
  note.innerHTML = text || 'Ханш ачаалагдаагүй байна. Хуудсаа шинэчилнэ үү.';
  note.hidden = false;
}

// A one-line summary of what was pressed, for the sign-in sheet.
function describe(intent) {
  if (intent.kind === 'package') {
    const pkg = state.packages.find((row) => row.id === intent.packageId);
    return pkg ? `${formatNumber(pkg.robuxAmount)} Robux · ${formatMnt(pkg.effectivePriceMnt)}` : '';
  }
  return intent.unit === 'mnt'
    ? `${formatMnt(intent.value)}-ийн цэнэглэлт`
    : `${formatNumber(intent.value)} Robux`;
}

const proceed = (intent) => openAuth(intent, describe(intent));

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// The figure is decoration and its file may not be there. A missing asset must
// not leave the browser's broken-image glyph in the middle of the page, and
// onerror="" on the tag itself — the obvious way to say that — is exactly what
// this site's nonce-based CSP blocks. So the check lives here, and it tests
// the image's state as well as listening: a 404 can land before this module
// has finished importing, and a listener attached after the fact never hears
// the event.
function initCharacter() {
  const layer = document.querySelector('.mm-character');
  const img = layer?.querySelector('img');
  if (!layer || !img) return;

  const drop = () => layer.remove();
  img.addEventListener('error', drop);
  if (img.complete && img.naturalWidth === 0) drop();
}

initShell();
initCharacter();

$('ladder').addEventListener('click', (event) => {
  const pressed = event.target.closest('.mm-row');
  if (!pressed) return;
  proceed({ kind: 'package', packageId: Number(pressed.dataset.packageId) });
});

Object.entries(UNITS).forEach(([name, config]) => {
  $(config.button).addEventListener('click', () => setUnit(name));
});

$('amount').addEventListener('input', updateConversion);

$('go').addEventListener('click', () => {
  const value = Number($('amount').value);
  if (!state.unit || !value || value <= 0) {
    $('amount').focus();
    return;
  }
  proceed({ kind: 'manual', unit: state.unit, value });
});

// Enter in the field is the same press as the button beside it.
$('amount').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('go').click();
  }
});

loadPackages();
loadPricing();
