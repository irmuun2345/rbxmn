// Time-boxed bonus promotions: the header countdown banner, the public
// promotions block on the landing page and the Events tab in the workspace.
//
// The same markup is written into both places rather than one being a
// summary of the other — a visitor deciding whether to sign up should see
// exactly what a signed-in customer sees.

import { $, setHidden, escapeHtml, renderLoading, renderEmpty, renderError } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatMnt, formatNumber, formatEventDate, formatClock, formatDuration } from '../common/format.js';

let eventsLoaded = false;

// The dot on the header bell. Both /events and /event-status can raise it and
// only the countdown can lower it, so it goes through one function rather
// than being poked from two places that would eventually disagree.
function setBellPip(on) {
  const pip = $('bell-pip');
  if (pip) pip.hidden = !on;
}

const eventLists = () => document.querySelectorAll('[data-events-list]');
const dealLists = () => document.querySelectorAll('[data-event-deals]');

function writeAll(nodes, html) {
  nodes.forEach((node) => { node.innerHTML = html; });
}

// Both copies of the list get the same state, so the renderers are applied
// per node rather than through writeAll's raw innerHTML.
function stateAll(nodes, render) {
  nodes.forEach(render);
}

function eventRow(event, now) {
  const starts = new Date(event.startsAt);
  const ends = new Date(event.endsAt);
  // Parallel phrasing rather than gluing a case suffix onto a number, which
  // does not inflect cleanly in Mongolian.
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
        <span class="badge ${event.live ? 'badge-ok' : 'badge-pending'}">${event.live ? 'Идэвхтэй' : 'Удахгүй'}</span>
      </div>
    </div>`;
}

export async function loadEvents({ force = false } = {}) {
  if (eventsLoaded && !force) return;
  if (!eventsLoaded) stateAll(eventLists(), (node) => renderLoading(node, { rows: 2 }));

  try {
    const data = await request('/events');
    eventsLoaded = true;

    // A live event puts a pip on the tab so it is discoverable without
    // opening it — rather the point of a time-boxed promotion.
    setHidden('tab-events-pip', !data.events.some((event) => event.live));

    const now = Date.now();
    if (data.events.length) {
      writeAll(eventLists(), data.events.map((event) => eventRow(event, now)).join(''));
    } else {
      stateAll(eventLists(), (node) => renderEmpty(node, {
        icon: '◷',
        title: 'Идэвхтэй эвент алга',
        body: 'Шинэ урамшуулал зарлагдмагц энд, мөн хуудасны дээд талд харагдана.',
        inline: true
      }));
    }

    const deals = data.discountedPackages;
    setHidden('event-deals-panel', !deals.length);
    setHidden('landing-deals-panel', !deals.length);
    writeAll(dealLists(), deals.map((pkg) => `
      <div class="data-row" data-tone="ok">
        <span class="data-row-main">
          <span class="data-row-title">${formatNumber(pkg.robuxAmount)} Robux</span>
          <span class="data-row-meta">
            <span><s>${formatMnt(pkg.priceMnt)}</s></span>
            <span class="sep">→</span>
            <span>${formatMnt(pkg.effectivePriceMnt)}</span>
          </span>
        </span>
        <span class="data-row-side">
          <span class="badge badge-ok">-${Number(pkg.discountPercent)}%</span>
        </span>
      </div>`).join(''));

    // An empty promotions block on the landing page is worse than none: it
    // reads as something that failed to load. Nothing running, nothing shown.
    const anything = data.events.length > 0 || deals.length > 0;
    setHidden('promos', !anything);

    // The card leaning on the price panel points at that same block, so it
    // appears and disappears with it — and it names what is actually on
    // rather than saying "Урамшуулал" over nothing. Both are guarded: the
    // Events tab renders through this function too, and the workspace has
    // neither element.
    const card = $('promo-card');
    if (card) {
      card.hidden = !anything;
      const live = data.events.find((event) => event.live);
      $('promo-card-note').textContent = live
        ? `+${Number(live.bonusPercent)}% бонус`
        : (deals.length ? `${deals.length} хямдралтай багц` : 'Удахгүй');
    }

    // A live promotion is the only thing the bell in the header has to say.
    setBellPip(data.events.some((event) => event.live) || deals.length > 0);
  } catch {
    stateAll(eventLists(), (node) => renderError(node, {
      title: 'Эвентүүд ачаалагдсангүй',
      retry: () => loadEvents({ force: true }),
      inline: true
    }));
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
    setHidden('tab-events-pip', false);
    setBellPip(true);

    const endsAt = new Date(data.endsAt).getTime();
    const tick = () => {
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        $('event-banner').hidden = true;
        setBellPip(false);
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
