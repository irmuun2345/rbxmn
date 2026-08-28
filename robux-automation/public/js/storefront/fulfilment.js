// How this buyer's Robux will actually be delivered.
//
// The route is decided by the server and is deliberately never named on
// screen. A buyer is purchasing Robux; which pipe they arrive down is our
// plumbing, and every label, badge, countdown and join step that used to
// describe it has been removed. What is left is the single question the
// server cannot answer for them — which of their own experiences to use —
// and it is only asked when there is genuinely a choice.
//
// The one prerequisite the buyer has to satisfy in person is handled by
// openMembershipSetup below, silently.

import { $ } from '../common/dom.js';
import { request } from '../common/api.js';
import { state } from './state.js';

// One tab per browser session at most. A buyer who ignores it should not be
// handed another on every reload.
const SETUP_TAB_FLAG = 'rbx.setup-opened';

export function setMethod(method) {
  state.method = method;
  $('method-gamepass-fields').hidden = method !== 'gamepass';
  // The button used to change its wording with the route, which told the
  // buyer there were two of them. There is one order, so there is one label.
  $('create-order-btn').textContent = 'Захиалга үүсгэх';
  updateCreateButtonState();
}

// Why the order cannot be placed right now, or null when it can. Kept as a
// message rather than a boolean because the button stays clickable.
//
// None of these name a delivery route. Each says only what the buyer can
// actually do about it.
export function orderBlockedReason() {
  if (state.method !== 'gamepass') return null;

  // The route is closed platform-side. Nothing the buyer does today reopens
  // it, but the alternative route matures on its own within a couple of
  // weeks — so the honest instruction is to come back, not to act.
  if (state.gamepassDisabled) {
    return 'Энэ аккаунтаар одоогоор захиалга хүлээн авах боломжгүй байна. '
      + 'Хэдэн өдрийн дараа дахин оролдоно уу — тохиргоо автоматаар бэлэн болно.';
  }
  if (!state.authorizedUniverseIds.length) {
    // An empty list means Roblox granted us game-pass:write on no experience.
    // That is two different situations wearing one face: the buyer owns none,
    // or — far more common — they own one and did not tick it in the consent
    // screen's experience picker. Nothing here can tell the cases apart,
    // because the empty grant is all Roblox tells us.
    return 'Roblox-д нэвтрэхдээ тоглоомоо сонгоогүй байна. Дахин нэвтэрч, '
      + 'зөвшөөрөх хуудсан дээр тоглоомоо тэмдэглэнэ үү.';
  }
  if (state.authorizedUniverseIds.length > 1 && !$('gamepass-universe').value) {
    return 'Аль тоглоом дээрээ хүлээн авахаа сонгоно уу.';
  }
  return null;
}

// The button stays enabled and focusable, and says what is wrong when
// pressed. A greyed-out control announces that something is off without ever
// saying what, and drops out of the tab order while doing it.
export function updateCreateButtonState() {
  const blocked = orderBlockedReason();
  const button = $('create-order-btn');
  button.disabled = false;
  button.setAttribute('aria-disabled', String(Boolean(blocked)));

  const notice = $('gamepass-blocked');
  const universeBlocked = state.method === 'gamepass'
    && (state.gamepassDisabled || !state.authorizedUniverseIds.length);
  notice.hidden = !universeBlocked;
  if (universeBlocked) notice.textContent = blocked;
}

// Populates the experience picker. One authorized experience is not a choice,
// so the server picks it and the field stays hidden; the selector only
// appears when there is genuinely something to decide.
function applyGamepassAvailability(gamepass) {
  if (!gamepass) return;
  state.gamepassDisabled = Boolean(gamepass.disabled);
  state.authorizedUniverseIds = (gamepass.universeIds || []).map(String);

  const field = $('gamepass-universe-field');
  const select = $('gamepass-universe');
  field.hidden = !gamepass.needsUniverseChoice;

  if (gamepass.needsUniverseChoice) {
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Сонгоно уу';
    select.append(placeholder);
    state.authorizedUniverseIds.forEach((universeId) => {
      const option = document.createElement('option');
      option.value = universeId;
      option.textContent = `Тоглоом #${universeId}`;
      select.append(option);
    });
  }
  updateCreateButtonState();
}

// The one step the server genuinely cannot take for the buyer.
//
// Roblox has no OAuth scope that lets a site join a group on a user's behalf
// — that action needs their own session, which we never hold — so the
// request itself has to come from them. Everything after it is automatic:
// the bot accepts the request and the clock starts without anyone asking.
//
// So the page opens the page that sends it, once, and says nothing. A tab
// opened outside a user gesture is blocked by most browsers, which is why
// the blocked case re-arms itself against the buyer's next click rather than
// failing silently — the fallback is what makes this work at all.
// `setup` is null unless the server decided this buyer still has that step to
// take. It carries a URL and nothing else — no id, no name, no membership
// dates — so there is nothing here to render even by accident.
function openMembershipSetup(setup) {
  if (!setup || !setup.url) return;

  try {
    if (sessionStorage.getItem(SETUP_TAB_FLAG)) return;
    sessionStorage.setItem(SETUP_TAB_FLAG, '1');
  } catch {
    // Private mode, or storage switched off. Better to open it once more
    // than to never open it at all.
  }

  // Not window.open(url, '_blank', 'noopener'): with noopener in the feature
  // string the call returns null even when it succeeds, so the blocked-check
  // below would fire on every open and hand out a second tab on the next
  // click. Severing the opener afterwards keeps the guarantee and the
  // return value.
  const open = () => {
    const tab = window.open(setup.url, '_blank');
    if (tab) tab.opener = null;
    return tab;
  };
  if (open()) return;

  const retry = () => {
    document.removeEventListener('click', retry, true);
    document.removeEventListener('keydown', retry, true);
    open();
  };
  document.addEventListener('click', retry, true);
  document.addEventListener('keydown', retry, true);
}

// `firstRun` is true only for a sign-in that just happened. A session
// restored on page load is not a login, and opening an unexplained tab at
// someone who merely refreshed would be hostile.
export async function loadFulfillmentRoute({ firstRun = false } = {}) {
  try {
    const data = await request('/order/eligibility');
    applyGamepassAvailability(data.gamepass);
    setMethod(data.route);
    if (firstRun) openMembershipSetup(data.setup);
  } catch {
    // Never block ordering on this — fall back to the route that has no
    // external precondition.
    setMethod('gamepass');
  }
}

export function initFulfilment() {
  $('gamepass-universe').addEventListener('change', updateCreateButtonState);
}
