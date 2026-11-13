// The chrome every page in the new front end carries: the bell, the Login
// pill, and the sign-in sheet the two of them open.
//
// It lives in its own module because the pages are separate documents rather
// than tabs — /, /giftcards, /invite, /faq and /promos each load their own
// markup, and without this they would each grow their own copy of the OAuth
// handshake. The markup for the chrome *is* repeated in each page, on purpose:
// a header that only exists once JavaScript has run is a header that flickers
// in on a slow connection and is missing entirely when a script fails.
//
// No password is asked for or handled anywhere in here. The link and the QR
// both point at Roblox's own authorisation page; this only ever polls our own
// server for the outcome.

import { $, escapeHtml } from '../common/dom.js';
import { request } from '../common/api.js';

// Where a press on a price is parked until there is an account to attach it
// to. The OAuth handshake leaves the page, so this has to outlive a
// navigation — sessionStorage does, and localStorage would outlive the whole
// visit, which is a stale intent waiting to surprise someone next week.
//
// The key is the workspace's own: packages.js reads it on the other side of
// the handshake and opens on the package that was pressed.
const INTENT_KEY = 'rbxmn:topup-intent';

// Where a signed-in buyer belongs. These pages sell; the workspace is where an
// order is actually placed, and it restores the session on its own.
export const WORKSPACE = '/app#buy';

const session = { id: null, timer: null };

export function rememberIntent(intent) {
  if (!intent) return;
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* Private mode, or storage disabled. The buyer picks again after signing
       in, which is the behaviour this mechanism improves on rather than the
       behaviour it depends on. */
  }
}

function note(message, isError = false) {
  const element = $('auth-note');
  element.textContent = message;
  element.classList.toggle('is-error', isError);
  element.hidden = !message;
}

/**
 * Open the sign-in sheet.
 *
 * @param {object} [intent]  what was pressed, parked for after the handshake
 * @param {string} [summary] one line naming it, so the sheet answers "why am
 *                           I being asked to sign in?" without the buyer
 *                           having to remember
 */
export function openAuth(intent = null, summary = '') {
  rememberIntent(intent);

  $('auth-intent').textContent = summary;
  $('auth-intent').hidden = !summary;

  const sheet = $('login');
  if (!sheet.open) sheet.showModal();
  $('auth-start').focus();
}

// Polls until Roblox tells our server the visitor approved — or refused.
// Stops on its own if a newer code has been generated in the meantime.
async function pollStatus(sessionId) {
  if (!session.id || session.id !== sessionId) return;
  try {
    const data = await request(
      `/auth/status/${encodeURIComponent(sessionId)}`,
      undefined,
      'Аккаунтын төлөв шалгаж чадсангүй.'
    );

    if (data.status === 'authenticated') {
      note(`${data.username} аккаунт холбогдлоо. Шилжиж байна…`);
      window.location.href = WORKSPACE;
    } else if (data.status === 'pending' || data.status === 'processing') {
      session.timer = setTimeout(() => pollStatus(sessionId), 2000);
    } else {
      note(data.error || 'Баталгаажуулалт дууссангүй. Дахин нэвтэрнэ үү.', true);
    }
  } catch (error) {
    note(error.message, true);
  }
}

async function startAuth() {
  const button = $('auth-start');
  button.disabled = true;
  button.textContent = 'Бэлдэж байна…';

  try {
    const data = await request('/auth/qr', undefined, 'Нэвтрэх код үүсгэж чадсангүй. Дахин оролдоно уу.');

    // A newer code supersedes any handshake already in flight.
    clearTimeout(session.timer);
    session.id = data.sessionId;

    // Assigned as properties rather than interpolated into markup: there is
    // no attribute to break out of this way, and both values are built by our
    // own server from a fixed Roblox host.
    $('oauth-link').href = data.authorizationUrl;
    $('qr-image').src = data.qrCode;
    $('qr-image').hidden = false;

    // A QR is only legible to a camera that is not the screen showing it. On
    // a touch device the visitor is almost certainly holding their only
    // screen, so it stays folded; on a pointer device, scanning with a phone
    // is the usual route in, so it is open.
    $('qr-fallback').open = window.matchMedia('(pointer: fine)').matches;
    $('auth-methods').hidden = false;

    note('10 минутын код бэлэн. Roblox дээр зөвшөөрөхийг хүлээж байна…');
    pollStatus(data.sessionId);
  } catch (error) {
    note(error.message, true);
  } finally {
    button.disabled = false;
    // Once a link is on screen it is the thing to press; this button drops
    // back to being the way out of an expired code.
    button.textContent = session.id ? 'Шинэ код авах' : 'Roblox-оор нэвтрэх';
  }
}

// Approving happens in a second tab, so this one sits in the background for
// the whole handshake — where browsers throttle timers to roughly once a
// minute. Whoever comes back here has just finished approving, so check
// immediately rather than leaving them looking at a stale sheet.
function initReturnCheck() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !session.id) return;
    clearTimeout(session.timer);
    pollStatus(session.id);
  });
}

// A session cookie outlives the page that created it, so a visitor who has
// signed in before should not be shown a Login pill. /profile is the cheapest
// endpoint that requires a session: if it answers, there is one, and its body
// already carries the username. A 401 is the normal answer for everyone else
// and means exactly what the page already shows, so it is swallowed.
async function restoreSession() {
  try {
    const data = await request('/profile');
    const pill = $('login-open');
    pill.href = WORKSPACE;
    pill.firstElementChild.textContent = data.user.username || 'Аккаунт';
    pill.dataset.signedIn = 'true';
  } catch {
    /* not signed in — the pill is already right */
  }
}

// One request answers both the dot on the bell and, where the page has one,
// the promo card — so the two can never disagree about whether there is an
// event on.
async function loadEventStatus() {
  try {
    const data = await request('/event-status');
    if (!data.active) return;

    $('bell-pip').hidden = false;

    const card = $('promo');
    if (!card) return;
    $('promo-note').innerHTML = `+${Number(data.bonusPercent)}% ${escapeHtml(data.name || 'бонус')}`;
    card.hidden = false;
  } catch {
    /* No event, or the endpoint is unhappy. Either way the page is complete
       without it: an empty promo card reads as something that failed. */
  }
}

/**
 * Wire the chrome. Every page calls this once, at the top of its own module.
 */
export function initShell() {
  initReturnCheck();

  $('login-open').addEventListener('click', (event) => {
    // Once there is a session the pill is a link to the workspace, not a way
    // into a sheet that would ask for one that already exists.
    if (event.currentTarget.dataset.signedIn) return;
    event.preventDefault();
    openAuth();
  });

  $('auth-start').addEventListener('click', startAuth);
  $('auth-close').addEventListener('click', () => $('login').close());

  // Clicking the backdrop closes it. The dialog element itself is the whole
  // visible sheet, so a press whose target *is* the dialog landed outside it.
  $('login').addEventListener('click', (event) => {
    if (event.target === $('login')) $('login').close();
  });

  // Anything on the page that only needs a session afterwards, not before.
  document.querySelectorAll('[data-auth]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      openAuth(null, trigger.dataset.auth || '');
    });
  });

  restoreSession();
  loadEventStatus();
}
