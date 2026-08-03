// What the storefront sells and at what discount: the fixed Robux packages,
// the loyalty levels, and the time-boxed bonus events.
//
// All three are small list editors with the same shape — load, render, add,
// remove — which is why they share a file rather than three near-identical
// ones.

import { $, escapeHtml, showResult } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt, formatNumber, formatDateTime } from '../common/format.js';

// ---------------------------------------------------------------------------
// Loyalty levels
// ---------------------------------------------------------------------------

let currentLevels = [];

function renderLevels() {
  if (!currentLevels.length) {
    $('levels-list').innerHTML = '<p class="hint">Түвшин тохируулаагүй байна.</p>';
    return;
  }
  $('levels-list').innerHTML = currentLevels.map((level) => `
    <div class="editable-row">
      <div>
        <strong>Түвшин ${Number(level.level)}</strong>
        <small>${formatNumber(level.threshold)} R$-аас дээш · ${Number(level.discountPercent) || 0}% хямдрал</small>
      </div>
      <button class="btn btn-danger btn-sm" type="button" data-remove-level="${Number(level.threshold)}">Хасах</button>
    </div>`).join('');
}

export async function loadLevels() {
  try {
    const data = await request('/admin/levels', undefined, 'Түвшингийн мэдээлэл авч чадсангүй.');
    currentLevels = data.levels;
    renderLevels();
  } catch (error) {
    showResult($('levels-result'), error.message, true);
  }
}

// The whole ladder is sent every time: the server stores it as one JSON
// setting, so there is no per-level endpoint to patch.
async function saveLevels(levels) {
  try {
    const data = await request('/admin/levels', jsonBody('PUT', { levels }), 'Түвшин хадгалахад алдаа гарлаа.');
    currentLevels = data.levels;
    renderLevels();
    showResult($('levels-result'), 'Түвшингүүд хадгалагдлаа.');
  } catch (error) {
    showResult($('levels-result'), error.message, true);
  }
}

function initLevels() {
  $('levels-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-level]');
    if (!button) return;
    const threshold = Number(button.dataset.removeLevel);
    await saveLevels(currentLevels.filter((level) => level.threshold !== threshold));
  });

  $('add-level-btn').addEventListener('click', async () => {
    const threshold = Number($('new-level-threshold').value);
    const discountPercent = Number($('new-level-discount').value) || 0;
    if (!Number.isInteger(threshold) || threshold < 1) {
      showResult($('levels-result'), 'Зөв босго тоо оруулна уу.', true);
      return;
    }
    await saveLevels([...currentLevels, { threshold, discountPercent }]);
    $('new-level-threshold').value = '';
    $('new-level-discount').value = '';
  });
}

// ---------------------------------------------------------------------------
// Bonus events
// ---------------------------------------------------------------------------

function renderEvents(events) {
  if (!events.length) {
    $('events-list').innerHTML = '<p class="hint">Идэвхтэй буюу төлөвлөсөн эвент алга.</p>';
    return;
  }
  const now = Date.now();
  $('events-list').innerHTML = events.map((event) => {
    const isActive = now >= new Date(event.starts_at).getTime() && now <= new Date(event.ends_at).getTime();
    return `
      <div class="editable-row">
        <div>
          <strong>${escapeHtml(event.name)}</strong>
          <small>+${Number(event.bonus_percent)}% · ${formatDateTime(new Date(event.starts_at))} → ${formatDateTime(new Date(event.ends_at))}</small>
        </div>
        <div class="action-buttons">
          <span class="badge ${isActive ? 'badge-active' : ''}">${isActive ? 'Идэвхтэй' : 'Товлогдсон'}</span>
          <button class="btn btn-danger btn-sm" type="button" data-remove-event="${Number(event.id)}">Устгах</button>
        </div>
      </div>`;
  }).join('');
}

export async function loadEvents() {
  try {
    const data = await request('/admin/events', undefined, 'Эвентийн мэдээлэл авч чадсангүй.');
    renderEvents(data.events);
  } catch (error) {
    showResult($('events-result'), error.message, true);
  }
}

function initEvents() {
  $('events-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-event]');
    if (!button) return;
    try {
      await request(`/admin/events/${button.dataset.removeEvent}`, { method: 'DELETE' }, 'Эвент устгаж чадсангүй.');
      await loadEvents();
    } catch (error) {
      showResult($('events-result'), error.message, true);
    }
  });

  $('add-event-btn').addEventListener('click', async () => {
    const button = $('add-event-btn');
    button.disabled = true;
    try {
      await request('/admin/events', jsonBody('POST', {
        name: $('event-name-input').value.trim(),
        bonusPercent: Number($('event-bonus-input').value),
        startsAt: $('event-start-input').value,
        endsAt: $('event-end-input').value
      }), 'Эвент үүсгэж чадсангүй.');
      ['event-name-input', 'event-bonus-input', 'event-start-input', 'event-end-input']
        .forEach((id) => { $(id).value = ''; });
      showResult($('events-result'), 'Эвент үүслээ.');
      await loadEvents();
    } catch (error) {
      showResult($('events-result'), error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Robux packages
// ---------------------------------------------------------------------------

let currentPackages = [];

function renderPackages() {
  if (!currentPackages.length) {
    $('packages-list').innerHTML = '<p class="hint">Багц үүсгээгүй байна.</p>';
    return;
  }
  $('packages-list').innerHTML = currentPackages.map((pkg) => `
    <div class="editable-row">
      <div>
        <strong>${formatNumber(pkg.robux_amount)} R$</strong>
        <small>${formatMnt(pkg.price_mnt)}${pkg.discount_percent > 0 ? ` · -${Number(pkg.discount_percent)}% хямдралтай` : ''}${pkg.is_active ? '' : ' · Идэвхгүй'}</small>
      </div>
      <div class="action-buttons">
        <span class="badge ${pkg.is_active ? 'badge-active' : ''}">${pkg.is_active ? 'Идэвхтэй' : 'Идэвхгүй'}</span>
        <button class="btn btn-ghost btn-sm" type="button" data-toggle-package="${Number(pkg.id)}">${pkg.is_active ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}</button>
        <button class="btn btn-danger btn-sm" type="button" data-remove-package="${Number(pkg.id)}">Устгах</button>
      </div>
    </div>`).join('');
}

export async function loadPackages() {
  try {
    const data = await request('/admin/packages', undefined, 'Багцын мэдээлэл авч чадсангүй.');
    currentPackages = data.packages;
    renderPackages();
  } catch (error) {
    showResult($('packages-result'), error.message, true);
  }
}

// The update route replaces every field, so an "activate" toggle has to
// resend the rest of the row unchanged.
async function togglePackage(id) {
  const pkg = currentPackages.find((item) => item.id === id);
  if (!pkg) return;
  try {
    await request(`/admin/packages/${pkg.id}`, jsonBody('PUT', {
      robuxAmount: pkg.robux_amount,
      priceMnt: pkg.price_mnt,
      discountPercent: pkg.discount_percent,
      isActive: !pkg.is_active,
      sortOrder: pkg.sort_order
    }), 'Багц шинэчлэгдсэнгүй.');
    await loadPackages();
  } catch (error) {
    showResult($('packages-result'), error.message, true);
  }
}

function initPackages() {
  $('packages-list').addEventListener('click', async (event) => {
    const toggleButton = event.target.closest('[data-toggle-package]');
    if (toggleButton) {
      await togglePackage(Number(toggleButton.dataset.togglePackage));
      return;
    }

    const removeButton = event.target.closest('[data-remove-package]');
    if (!removeButton) return;
    try {
      await request(`/admin/packages/${removeButton.dataset.removePackage}`, { method: 'DELETE' }, 'Багц устгаж чадсангүй.');
      await loadPackages();
    } catch (error) {
      showResult($('packages-result'), error.message, true);
    }
  });

  $('add-package-btn').addEventListener('click', async () => {
    const robuxAmount = Number($('new-package-amount').value);
    const priceMnt = Number($('new-package-price').value);
    const discountPercent = Number($('new-package-discount').value) || 0;

    if (!Number.isInteger(robuxAmount) || robuxAmount < 1) {
      showResult($('packages-result'), 'Robux хэмжээг зөв оруулна уу.', true);
      return;
    }
    if (!Number.isInteger(priceMnt) || priceMnt < 1) {
      showResult($('packages-result'), 'Үнийг зөв оруулна уу.', true);
      return;
    }

    try {
      await request('/admin/packages', jsonBody('POST', { robuxAmount, priceMnt, discountPercent }), 'Багц үүсгэж чадсангүй.');
      ['new-package-amount', 'new-package-price', 'new-package-discount']
        .forEach((id) => { $(id).value = ''; });
      showResult($('packages-result'), 'Багц үүслээ.');
      await loadPackages();
    } catch (error) {
      showResult($('packages-result'), error.message, true);
    }
  });
}

export function initCatalog() {
  initLevels();
  initEvents();
  initPackages();
}
