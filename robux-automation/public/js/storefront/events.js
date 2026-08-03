// Time-boxed bonus promotions: the header countdown banner and the Events
// tab that lists what is running and what is coming.

import { $, escapeHtml } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber, formatEventDate, formatClock, formatDuration } from '../common/format.js';

let eventsLoaded = false;

export async function loadEvents({ force = false } = {}) {
  if (eventsLoaded && !force) return;
  const list = $('events-list');
  try {
    const data = await request('/events');
    eventsLoaded = true;

    // A live event puts a pip on the tab so it is discoverable without
    // opening it — rather the point of a time-boxed promotion.
    $('tab-events-pip').hidden = !data.events.some((event) => event.live);

    if (!data.events.length) {
      list.innerHTML = '<p class="hint">Одоогоор идэвхтэй эвент алга. Шинэ урамшуулал зарлагдмагц энд харагдана.</p>';
    } else {
      const now = Date.now();
      list.innerHTML = data.events.map((event) => {
        const starts = new Date(event.startsAt);
        const ends = new Date(event.endsAt);
        // Parallel phrasing rather than gluing a case suffix onto a number,
        // which does not inflect cleanly in Mongolian.
        const remaining = event.live
          ? `Дуусахад ${formatDuration(ends.getTime() - now)} үлдлээ`
          : `Эхлэхэд ${formatDuration(starts.getTime() - now)} үлдлээ`;
        return `
          <div class="event-row${event.live ? ' is-live' : ''}">
            <div class="event-row-main">
              <strong>${escapeHtml(event.name)}</strong>
              <small>${escapeHtml(formatEventDate(starts))} — ${escapeHtml(formatEventDate(ends))}</small>
              <small>${escapeHtml(remaining)}</small>
            </div>
            <div class="event-row-side">
              <span class="event-bonus tabular">+${Number(event.bonusPercent)}%</span>
              <span class="badge ${event.live ? 'badge-active' : ''}">${event.live ? 'Идэвхтэй' : 'Удахгүй'}</span>
            </div>
          </div>`;
      }).join('');
    }

    const deals = data.discountedPackages;
    $('event-deals-panel').hidden = !deals.length;
    $('event-deals-list').innerHTML = deals.map((pkg) => `
      <div class="editable-row">
        <div>
          <strong>${formatNumber(pkg.robuxAmount)} R$</strong>
          <small><s>${formatMnt(pkg.priceMnt)}</s> → ${formatMnt(pkg.effectivePriceMnt)}</small>
        </div>
        <span class="badge badge-active">-${Number(pkg.discountPercent)}%</span>
      </div>`).join('');
  } catch {
    list.innerHTML = '<p class="hint">Эвентийн мэдээлэл ачаалж чадсангүй.</p>';
  }
}

// The banner across the top of the page while a promotion is running.
export async function loadEventStatus() {
  try {
    const data = await request('/event-status');
    if (!data.active) return;
    $('event-name').textContent = data.name;
    $('event-bonus').textContent = `+${data.bonusPercent}%`;
    $('event-banner').hidden = false;
    $('tab-events-pip').hidden = false;

    const endsAt = new Date(data.endsAt).getTime();
    const tick = () => {
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        $('event-banner').hidden = true;
        clearInterval(timer);
        return;
      }
      $('event-countdown').textContent = formatClock(remaining);
    };
    tick();
    const timer = setInterval(tick, 1000);
  } catch {
    /* no active event — banner stays hidden */
  }
}
