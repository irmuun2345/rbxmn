// Number and currency formatting, shared by the storefront and the dashboard
// so the two can never disagree about how a price is written.

export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The tugrik sign is what a Mongolian buyer reads prices in; "MNT" is an
// accounting code. Kept as one helper so the two never drift apart.
//
// The separator is a non-breaking space, and it is load-bearing twice over.
// IBM Plex Mono — and every other mono face tried — has no ₮ glyph, so the
// browser substitutes a proportional one that is wider than the monospace
// cell and bleeds left over the final digit when set flush. It also stops
// "36,000" and "₮" being split across a line break.
//
// ICU's own mn-MN currency format is no help here: it yields "MNT 36,000" or
// a leading "₮36,000", neither of which is how prices are written locally.
export function formatMnt(value) {
  const amount = new Intl.NumberFormat('mn-MN', { maximumFractionDigits: 0 })
    .format(Math.round(value));
  return `${amount} ₮`;
}

// Plain grouped number, for Robux counts and tallies that carry their own
// unit label.
export function formatNumber(value) {
  return new Intl.NumberFormat('mn-MN').format(Math.round(Number(value) || 0));
}

// Animates the text of `el` from its current numeric value to `to`, keeping
// non-digit characters (currency labels etc.) intact via `formatter`.
export function animateNumber(el, to, formatter = (n) => String(Math.round(n))) {
  const from = Number(String(el.dataset.value || '0').replace(/[^0-9.-]/g, '')) || 0;
  el.dataset.value = to;
  if (reduceMotion || from === to) {
    el.textContent = formatter(to);
    return;
  }
  const duration = 600;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    el.textContent = formatter(from + (to - from) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Dates are built by hand, and that is not stubbornness.
//
// Chrome's Intl has almost no Mongolian data, so toLocaleString('mn-MN')
// quietly falls back to en-US: an admin reconciling a bank transfer was
// reading "8/1/2026, 6:00:00 PM" — English, 12-hour, and ambiguous about
// whether it means 1 August or 8 January. The Mongolian form is
// "8-р сарын 1", and the country runs on a 24-hour clock.
//
// Every date shown anywhere in this app goes through one of the three
// functions below, so none of them can drift back to that.
const pad = (value) => String(value).padStart(2, '0');

// "8-р сарын 1"
export function formatDate(date) {
  return `${date.getMonth() + 1}-р сарын ${date.getDate()}`;
}

// "8-р сарын 1, 18:00"
export function formatDateTime(date) {
  return `${formatDate(date)}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// SQLite stores timestamps as UTC without a zone marker, so the 'Z' has to be
// appended before parsing or the browser reads them as local time and every
// admin timestamp is off by the timezone offset.
export function formatStoredDateTime(stored) {
  return formatDateTime(new Date(`${stored}Z`));
}

// Kept as its own name because the events list reads as a range.
export const formatEventDate = formatDateTime;

export function formatClock(msRemaining) {
  const total = Math.max(0, msRemaining);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// "4 хоног 3 цаг". Drops a zero component rather than printing "4 хоног 0 цаг".
export function formatDuration(msRemaining) {
  const totalMinutes = Math.max(0, Math.floor(msRemaining / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} хоног ${hours} цаг` : `${days} хоног`;
  if (hours > 0) return minutes > 0 ? `${hours} цаг ${minutes} мин` : `${hours} цаг`;
  return `${minutes} мин`;
}
