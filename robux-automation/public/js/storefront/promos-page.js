// /promos — running and upcoming bonus events, and whatever is discounted
// today.
//
// Everything on this page is fetched. An event list baked into the markup is
// an event list that goes on advertising a promotion a week after it ended,
// and the countdown is the whole reason someone opens this page.

import { $, escapeHtml } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber, formatEventDate, formatDuration } from '../common/format.js';
import { initShell } from './shell.js';

initShell();

let events = [];
let ticker = null;

const coin = `
  <svg class="mm-coin" viewBox="0 0 24 24" aria-hidden="true">
    <path class="coin-body" d="M12 2.4l8.3 4.8v9.6L12 21.6 3.7 16.8V7.2z"/>
    <path class="coin-stud" d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z"/>
  </svg>`;

// Parallel phrasing rather than gluing a case suffix onto a number, which does
// not inflect cleanly in Mongolian.
function remaining(event, now) {
  return event.live
    ? `Дуусахад ${formatDuration(new Date(event.endsAt).getTime() - now)} үлдлээ`
    : `Эхлэхэд ${formatDuration(new Date(event.startsAt).getTime() - now)} үлдлээ`;
}

function eventRow(event, now) {
  return `
    <article class="event${event.live ? ' is-live' : ''}">
      <div class="event-main">
        <strong>${escapeHtml(event.name)}</strong>
        <small>${escapeHtml(formatEventDate(new Date(event.startsAt)))} — ${escapeHtml(formatEventDate(new Date(event.endsAt)))}</small>
        <small data-countdown="${escapeHtml(String(event.id))}">${escapeHtml(remaining(event, now))}</small>
      </div>
      <div class="event-side">
        <span class="event-bonus">+${Number(event.bonusPercent)}%</span>
        <span class="badge${event.live ? ' is-live' : ''}">${event.live ? 'Идэвхтэй' : 'Удахгүй'}</span>
      </div>
    </article>`;
}

// Only the one line that changes is rewritten each second. Re-rendering the
// whole list on a timer would tear the page out from under anyone who had a
// row focused, and would fight the browser's own text selection.
function tick() {
  const now = Date.now();
  events.forEach((event) => {
    const line = document.querySelector(`[data-countdown="${CSS.escape(String(event.id))}"]`);
    if (line) line.textContent = remaining(event, now);
  });
}

function dealRow(pkg) {
  return `
    <a class="mm-row" href="/">
      <span class="mm-price">${formatMnt(pkg.effectivePriceMnt)}</span>
      <span class="mm-robux">${coin}${formatNumber(pkg.robuxAmount)}</span>
      <span class="mm-off">${Number(pkg.discountPercent)}% хямдрал</span>
    </a>`;
}

async function load() {
  $('events-list').innerHTML = '<div class="mm-skeleton"></div><div class="mm-skeleton"></div>';

  try {
    const data = await request('/events');
    events = data.events || [];

    if (!events.length) {
      $('events-list').innerHTML = `
        <p class="state"><strong>Одоогоор эвент алга</strong>
        Шинэ урамшуулал зарлагдмагц энд гарч ирнэ. Хонхны тэмдэг дээр цэг гарвал эвент эхэлсэн гэсэн үг.</p>`;
    } else {
      // Live first, then whatever starts soonest: someone opening this page
      // wants to know what they can use right now.
      events.sort((a, b) => (Number(b.live) - Number(a.live))
        || (new Date(a.startsAt) - new Date(b.startsAt)));

      const now = Date.now();
      $('events-list').innerHTML = events.map((event) => eventRow(event, now)).join('');

      clearInterval(ticker);
      ticker = setInterval(tick, 1000);
    }

    const deals = data.discountedPackages || [];
    if (deals.length) {
      $('deals-list').innerHTML = deals.map(dealRow).join('');
      $('deals-section').hidden = false;
    }
  } catch {
    $('events-list').innerHTML = `
      <p class="state"><strong>Ачаалж чадсангүй</strong>
      Эвентийн мэдээллийг татаж чадсангүй.
      <button type="button" id="events-retry">Дахин оролдох</button></p>`;
    $('events-retry').addEventListener('click', load);
  }
}

load();
