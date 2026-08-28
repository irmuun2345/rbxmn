// Delivered sales: one filtered view of what has actually been delivered.
//
// Separate from orders.js on purpose: that file counts rows in the queue it
// just fetched, which only ever covers orders still worth working. Everything
// here is counted by Postgres over the whole history, so the page never has
// to hold every order ever placed just to add them up.

import { $, escapeHtml, showResult } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber, formatStoredDateTime } from '../common/format.js';

// Order matters — this is the order of the preset chips. Today first,
// because it is the range an admin opens the dashboard on.
const PERIODS = [
  ['today', 'Өнөөдөр'],
  ['yesterday', 'Өчигдөр'],
  ['week', 'Сүүлийн 7 хоног'],
  ['month', 'Энэ сар'],
  ['lastMonth', 'Өнгөрсөн сар'],
  ['total', 'Нийт']
];

const PAGE_SIZE = 50;

// The date range each preset covers, as resolved by the server. Held here so
// pressing a chip fills the boxes with Ulaanbaatar dates rather than with
// whatever day it happens to be on the machine the admin is sitting at.
let periodRanges = {};

// How many rows are on screen, and the filter that produced them. Kept apart
// from the input boxes so that editing a box cannot append the next page of
// one search onto the results of another.
let loaded = 0;
let activeFilters = { from: '', to: '', search: '' };

/* ============================================================
   The periods, as presets
   ============================================================ */

const todayRobux = (stats) => `${formatNumber(stats.today?.robux || 0)} Robux`;

function renderPresets() {
  $('sales-presets').innerHTML = PERIODS.map(([key, label]) => `
    <button class="chip" type="button" role="radio" aria-checked="false" data-preset="${key}">
      ${label}
    </button>`).join('');
}

// Which chip, if any, describes what is currently in the boxes. Derived from
// the dates rather than remembered from the click, so a range typed by hand
// that happens to be this month lights its chip up too — and nudging a preset
// by a day correctly puts every chip out.
function markActivePreset() {
  const from = $('sales-from').value;
  const to = $('sales-to').value;
  $('sales-presets').querySelectorAll('[data-preset]').forEach((chip) => {
    const range = periodRanges[chip.dataset.preset];
    const matches = Boolean(range)
      && (range.from || '') === from
      && (range.to || '') === to;
    chip.setAttribute('aria-checked', String(matches));
  });
}

function applyPreset(key) {
  const range = periodRanges[key];
  if (!range) return;
  $('sales-from').value = range.from || '';
  $('sales-to').value = range.to || '';
  markActivePreset();
}

export async function loadSalesStats() {
  try {
    const data = await request('/admin/orders/stats', undefined, 'Борлуулалтын тоог авч чадсангүй.');
    periodRanges = data.periods || {};
    // The one figure still read rather than searched for: today's payout, in
    // the strip at the top of the page.
    $('today-robux-stat').textContent = todayRobux(data.stats);
    renderPresets();

    // The drill-down opens on today: the range an admin wants nine times out
    // of ten, and the only one they never have to think about.
    if (!$('sales-from').value && !$('sales-to').value) applyPreset('today');
    markActivePreset();
  } catch (error) {
    // The presets are what this call is for. Without them the date boxes
    // still work, so the panel is degraded rather than dead.
    showResult($('sales-result'), error.message, true);
  }
}

/* ============================================================
   The filtered list
   ============================================================ */

function currentFilters() {
  return {
    from: $('sales-from').value,
    to: $('sales-to').value,
    search: $('sales-search').value.trim()
  };
}

function describeRange({ from, to }) {
  if (from && to) return from === to ? from : `${from} — ${to}`;
  if (from) return `${from}-с хойш`;
  if (to) return `${to} хүртэл`;
  return 'Бүх хугацаа';
}

function salesRow(sale) {
  const isGroup = sale.deliveryMethod === 'group';
  const reference = sale.paymentReference
    ? `<span class="ref-code">${escapeHtml(sale.paymentReference)}</span>`
    : '<small class="dim">—</small>';
  return `
    <tr>
      <td data-label="Огноо">${escapeHtml(formatStoredDateTime(sale.completedAt))}</td>
      <td data-label="Хэрэглэгч">
        <strong>${escapeHtml(sale.username)}</strong>
        <small>Roblox ID ${escapeHtml(sale.robloxId)} · ${isGroup ? 'Группээр' : 'Pass'}</small>
      </td>
      <td data-label="Лавлах">${reference}</td>
      <td data-label="Robux" class="tabular">${formatNumber(sale.robux)} Robux</td>
      <td data-label="Дүн" class="tabular">${formatMnt(sale.mnt)}</td>
    </tr>`;
}

// `append` is what separates "Илүү ихийг харах" from a fresh search: one
// request serves both, and only the handling of the rows differs.
async function loadSales({ append = false } = {}) {
  const filters = append ? activeFilters : currentFilters();
  const offset = append ? loaded : 0;

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (filters.search) query.set('search', filters.search);

  const more = $('sales-more');
  more.hidden = true;

  if (!append) {
    $('sales-results').innerHTML =
      '<tr><td class="empty-cell" colspan="5">Ачаалж байна…</td></tr>';
  }

  try {
    const data = await request(
      `/admin/orders/sales?${query}`,
      undefined,
      'Борлуулалтыг хайж чадсангүй.'
    );

    activeFilters = filters;
    loaded = offset + data.sales.length;

    const rows = data.sales.map(salesRow).join('');
    if (append) {
      $('sales-results').insertAdjacentHTML('beforeend', rows);
    } else if (!data.sales.length) {
      $('sales-results').innerHTML =
        '<tr><td class="empty-cell" colspan="5">Энэ шүүлтүүрт тохирох борлуулалт алга.</td></tr>';
    } else {
      $('sales-results').innerHTML = rows;
    }

    const term = filters.search ? ` · "${escapeHtml(filters.search)}"` : '';
    // The totals describe the whole filter rather than the page on screen,
    // so they are said in full and the row count is left to the list.
    $('sales-summary').innerHTML = `
      ${escapeHtml(describeRange(filters))}${term} ·
      <strong>${formatNumber(data.totals.orders)}</strong> захиалга ·
      <strong>${formatNumber(data.totals.robux)} Robux</strong> ·
      <strong>${formatMnt(data.totals.mnt)}</strong>`;

    more.hidden = !data.hasMore;
    $('sales-result').hidden = true;
  } catch (error) {
    if (!append) {
      $('sales-results').innerHTML =
        '<tr><td class="empty-cell" colspan="5">Борлуулалтыг харуулж чадсангүй.</td></tr>';
    }
    showResult($('sales-result'), error.message, true);
  }
}

export function initSales() {
  $('sales-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    loadSales();
  });

  // A preset is a shortcut, so it runs the search rather than filling the
  // boxes and waiting for a second press.
  $('sales-presets').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-preset]');
    if (!chip) return;
    applyPreset(chip.dataset.preset);
    loadSales();
  });

  ['sales-from', 'sales-to'].forEach((id) => {
    $(id).addEventListener('change', markActivePreset);
  });

  $('sales-reset').addEventListener('click', () => {
    $('sales-search').value = '';
    applyPreset('today');
    loadSales();
  });

  $('sales-more').addEventListener('click', () => loadSales({ append: true }));
}

// Runs after loadSalesStats, which is what fills in the preset ranges the
// opening search reads.
export async function loadSalesList() {
  await loadSales();
}
