// Connecting a Roblox account through the official OAuth flow, and letting
// go of it again.
//
// No password is ever asked for or handled here: the QR and the link both
// point at Roblox's own authorisation page, and this page only ever polls its
// own server for the outcome.

import { $, escapeHtml, showResult, setLoading } from '../common/dom.js';
import { request } from '../common/api.js';
import { state } from './state.js';
import { updateGateVisibility } from './gates.js';
import { setAccountMenuOpen } from './account-menu.js';
import { setMethod, updateCreateButtonState, loadFulfillmentRoute, loadGroupInfo } from './fulfilment.js';
import { loadProfile } from './profile.js';
import { checkPhoneStatus } from './phone.js';
import { loadMyGiftCards } from './gift-cards.js';
import { loadReferral } from './referral.js';
import { resetOrderPanel } from './order.js';
import { selectTab } from './tabs.js';

// Everything the page can only fetch once a session exists.
export function revealAuthenticated(username, universeIds = []) {
  state.isAuthenticated = true;
  // loadFulfillmentRoute re-states this from the server along with whether a
  // choice is even needed; this is just the earliest we know.
  state.authorizedUniverseIds = universeIds.map(String);
  $('auth-state').textContent = username || 'Холбогдсон';
  $('auth-state').className = 'badge badge-active';
  $('account-name').textContent = username || 'Аккаунт';

  updateCreateButtonState();
  updateGateVisibility();

  loadGroupInfo();
  loadFulfillmentRoute();
  loadProfile();
  checkPhoneStatus();
  loadMyGiftCards();
  loadReferral();

  // The auth card just vanished from above the fold; land the buyer on the
  // thing that replaced it rather than wherever the page reflowed to.
  selectTab('buy');
  $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Polls until Roblox tells our server the user approved (or refused). Stops
// on its own if a newer QR has been generated in the meantime.
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
      setTimeout(() => checkAuthStatus(sessionId), 2000);
    } else {
      showResult($('qr-result'), data.error || 'Баталгаажуулалт дууссангүй. Шинэ QR код үүсгэнэ үү.', true);
    }
  } catch (error) {
    showResult($('qr-result'), error.message, true);
  }
}

function initQrCode() {
  $('generate-qr-btn').addEventListener('click', async () => {
    const button = $('generate-qr-btn');
    setLoading(button, true, 'Үүсгэж байна…');
    $('qr-container').innerHTML = '<p>Нэг удаагийн код авч байна…</p>';
    try {
      const data = await request('/auth/qr', undefined, 'QR код үүсгэж чадсангүй. Дахин оролдоно уу.');
      state.sessionId = data.sessionId;
      // Both values land inside an attribute, so both are escaped — even
      // though one is a data: URI this server rendered itself. A quote that
      // slipped through either would close the attribute early.
      $('qr-container').innerHTML = `
        <div>
          <img src="${escapeHtml(data.qrCode)}" alt="Roblox OAuth зөвшөөрлийн QR код">
          <span>Утасныхаа камераар уншуулах эсвэл доорх холбоосыг нээнэ үү.</span>
          <a class="btn oauth-link" href="${escapeHtml(data.authorizationUrl)}"
             target="_blank" rel="noopener noreferrer">Roblox дээр нээх ↗</a>
        </div>`;
      showResult($('qr-result'), '10 минутын код бэлэн. Roblox дээр зөвшөөрөхийг хүлээж байна…');
      checkAuthStatus(data.sessionId);
    } catch (error) {
      $('qr-container').innerHTML = '<p>Код үүссэнгүй. Дахин оролдоно уу.</p>';
      showResult($('qr-result'), error.message, true);
    } finally {
      setLoading(button, false);
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

      resetOrderPanel();
      setAccountMenuOpen(false);
      updateGateVisibility();

      $('gamepass-universe').replaceChildren();
      $('gamepass-universe-field').hidden = true;
      // Logged out, so there's no account to compute a route for.
      setMethod('gamepass');
      $('route-banner').hidden = true;
      $('route-unlock').hidden = true;
      $('auth-state').textContent = 'Холбогдоогүй';
      $('auth-state').className = 'badge';

      showResult($('qr-result'), 'Аккаунтын холболт саллаа.');
      $('auth-card').scrollIntoView({ behavior: 'smooth' });
    } catch (error) {
      showResult($('profile-result'), error.message, true);
    }
  });
}

export function initAuth() {
  initQrCode();
  initLogout();
}
