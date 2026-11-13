// Connecting a Roblox account through the official OAuth flow, and letting
// go of it again.
//
// No password is ever asked for or handled here: the QR and the link both
// point at Roblox's own authorisation page, and this page only ever polls its
// own server for the outcome.

import { $, showResult, setLoading } from '../common/dom.js';
import { request } from '../common/api.js';
import { state } from './state.js';
import { updateGateVisibility } from './gates.js';
import { setAccountMenuOpen } from './account-menu.js';
import { setMethod, updateCreateButtonState, loadFulfillmentRoute } from './fulfilment.js';
import { loadProfile } from './profile.js';
import { checkPhoneStatus } from './phone.js';
import { refreshGiftQuote, resetGiftPanel } from './gift-cards.js';
import { loadOrders, resetOrders } from './orders.js';
import { loadReferral } from './referral.js';
import { resetOrderPanel } from './order.js';
import { selectTab } from './tabs.js';

// Everything the page can only fetch once a session exists.
export function revealAuthenticated(username, universeIds = [], { land = true } = {}) {
  state.isAuthenticated = true;
  state.username = username || '';
  // loadFulfillmentRoute re-states this from the server along with whether a
  // choice is even needed; this is just the earliest we know.
  state.authorizedUniverseIds = universeIds.map(String);
  $('auth-state').textContent = username || 'Холбогдсон';
  $('auth-state').className = 'badge badge-active login-state';
  $('account-name').textContent = username || 'Аккаунт';
  $('workspace-greeting').textContent = username ? `Сайн уу, ${username}` : 'Тавтай морил';

  updateCreateButtonState();
  updateGateVisibility();

  loadFulfillmentRoute({ firstRun: land });
  loadProfile();
  checkPhoneStatus();
  loadReferral();
  // Orders and gift cards are one list now, so this is both of them.
  loadOrders();
  // The gift quote reads the level discount loadProfile is fetching; this is
  // the first draw, and refreshGiftQuote runs again on every keystroke.
  refreshGiftQuote();

  // The landing page just vanished from under the buyer; put them at the top
  // of what replaced it rather than wherever the page happened to reflow to.
  // Skipped when the session was merely restored on load: nothing moved, and
  // a #tab in the URL is the visitor's own choice of where to be.
  if (land) {
    selectTab('buy');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// A session cookie outlives the page that created it, so a visitor who has
// signed in before should not be shown the sales pitch and asked to do it
// again. /profile is the cheapest endpoint that requires a session: if it
// answers, there is one, and its body already carries the username.
//
// A 401 is the normal answer for everyone else and means exactly what the
// page already shows, so it is swallowed rather than surfaced.
export async function restoreSession() {
  try {
    const data = await request('/profile');
    revealAuthenticated(data.user.username, [], { land: false });
  } catch {
    /* not signed in — the landing page is already the right thing to show */
  }
}

// Polls until Roblox tells our server the user approved (or refused). Stops
// on its own if a newer code has been generated in the meantime.
async function checkAuthStatus(sessionId) {
  if (!state.sessionId || state.sessionId !== sessionId) return;
  try {
    const data = await request(
      `/auth/status/${encodeURIComponent(sessionId)}`,
      undefined,
      'Аккаунтын төлөв шалгаж чадсангүй.'
    );
    if (data.status === 'authenticated') {
      showResult($('qr-result'), `${data.username} аккаунт холбогдлоо.`);
      revealAuthenticated(data.username, data.authorizedUniverseIds || []);
    } else if (data.status === 'pending' || data.status === 'processing') {
      state.authPollTimer = setTimeout(() => checkAuthStatus(sessionId), 2000);
    } else {
      showResult($('qr-result'), data.error || 'Баталгаажуулалт дууссангүй. Дахин нэвтэрнэ үү.', true);
    }
  } catch (error) {
    showResult($('qr-result'), error.message, true);
  }
}

// Approving happens in a second tab, so this one sits in the background for
// the whole handshake — where browsers throttle timers to roughly once a
// minute. Whoever comes back here has just finished approving, so check
// immediately rather than leaving them looking at a stale card.
//
// The pending timer is cleared first: two live chains would both reach the
// authenticated branch and boot the signed-in page twice.
function initReturnCheck() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.sessionId || state.isAuthenticated) return;
    clearTimeout(state.authPollTimer);
    checkAuthStatus(state.sessionId);
  });
}

function initQrCode() {
  $('generate-qr-btn').addEventListener('click', async () => {
    const button = $('generate-qr-btn');
    setLoading(button, true, 'Бэлдэж байна…');
    try {
      const data = await request('/auth/qr', undefined, 'Нэвтрэх код үүсгэж чадсангүй. Дахин оролдоно уу.');
      // A newer code supersedes any handshake already in flight.
      clearTimeout(state.authPollTimer);
      state.sessionId = data.sessionId;

      // Assigned as properties rather than interpolated into markup: there is
      // no attribute to break out of this way, so neither value needs
      // escaping. Both are built by our own server from a fixed Roblox host.
      $('oauth-link').href = data.authorizationUrl;
      $('qr-image').src = data.qrCode;
      $('qr-image').hidden = false;

      // A QR is only legible to a camera that is not the screen showing it.
      // On a touch device the visitor is almost certainly holding their only
      // screen, so it stays folded; on a pointer device, scanning with a
      // phone is the usual route in, so it is open.
      $('qr-fallback').open = window.matchMedia('(pointer: fine)').matches;
      $('auth-methods').hidden = false;

      showResult($('qr-result'), '10 минутын код бэлэн. Roblox дээр зөвшөөрөхийг хүлээж байна…');
      checkAuthStatus(data.sessionId);
    } catch (error) {
      showResult($('qr-result'), error.message, true);
    } finally {
      setLoading(button, false);
      // Once a link is on screen it is the thing to press; this button drops
      // back to being the way out of an expired code. Relabelled after
      // setLoading, which restores the label it captured.
      if (state.sessionId) {
        button.textContent = 'Шинэ код авах';
        button.classList.replace('btn-primary', 'btn-ghost');
      }
    }
  });
}

function initLogout() {
  $('logout-btn').addEventListener('click', async () => {
    try {
      await request('/logout', { method: 'POST' }, 'Холболтыг салгаж чадсангүй.');

      state.isAuthenticated = false;
      state.phoneLinked = false;
      state.authorizedUniverseIds = [];
      state.sessionId = null;
      clearTimeout(state.authPollTimer);

      // The old code was spent signing in, so put the card back the way a
      // first-time visitor finds it rather than leaving a dead link on it.
      $('auth-methods').hidden = true;
      $('qr-image').hidden = true;
      $('qr-image').removeAttribute('src');
      $('oauth-link').href = '#';
      $('generate-qr-btn').textContent = 'Roblox-оор нэвтрэх';
      $('generate-qr-btn').classList.replace('btn-ghost', 'btn-primary');

      resetOrderPanel();
      // The gift panel can be showing the previous account's payment
      // reference, which is the last thing the next person should see.
      resetGiftPanel();
      resetOrders();
      setAccountMenuOpen(false);
      updateGateVisibility();

      $('gamepass-universe').replaceChildren();
      $('gamepass-universe-field').hidden = true;
      // The previous account's experiences, and whether they were ready.
      state.authorizedUniverseIds = [];
      state.experienceReadiness = {};
      $('gamepass-setup').hidden = true;
      $('gamepass-setup-result').hidden = true;
      // Logged out, so there's no account to compute a route for.
      setMethod('gamepass');
      $('auth-state').textContent = 'Холбогдоогүй';
      $('auth-state').className = 'badge login-state';

      $('workspace-greeting').textContent = 'Тавтай морил';
      showResult($('qr-result'), 'Аккаунтын холболт саллаа.');
      $('login').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      showResult($('profile-result'), error.message, true);
    }
  });
}

export function initAuth() {
  initQrCode();
  initReturnCheck();
  initLogout();
}
