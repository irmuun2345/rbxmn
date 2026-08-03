// How this buyer's Robux will actually be delivered.
//
// The route is decided by the server from group-membership eligibility, and
// the buyer has no say in it: group payout carries a platform-imposed
// membership requirement, so offering it as a free choice would just produce
// paid orders Roblox refuses to fulfil. Everything here renders that answer.

import { $, showResult, setLoading } from '../common/dom.js';
import { request } from '../common/api.js';
import { state } from './state.js';

export function setMethod(method) {
  state.method = method;
  $('method-group-fields').hidden = method !== 'group';
  $('method-gamepass-fields').hidden = method !== 'gamepass';
  $('create-order-btn').textContent = method === 'group'
    ? 'Захиалга үүсгэх'
    : 'Game Pass-аар захиалах';
  updateCreateButtonState();
}

// Why the order cannot be placed right now, or null when it can. Kept as a
// message rather than a boolean because the button stays clickable.
export function orderBlockedReason() {
  if (state.method !== 'gamepass') return null;
  if (!state.authorizedUniverseIds.length) {
    return 'Танд Game Pass үүсгэх тоглоом алга. Доорх группд элсээрэй.';
  }
  if (state.authorizedUniverseIds.length > 1 && !$('gamepass-universe').value) {
    return 'Аль тоглоом дээр үүсгэхээ сонгоно уу.';
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
  const universeBlocked = state.method === 'gamepass' && !state.authorizedUniverseIds.length;
  notice.hidden = !universeBlocked;
  if (universeBlocked) notice.textContent = blocked;
}

// Populates the Game Pass experience picker. One authorized experience is not
// a choice, so the server picks it and the field stays hidden; the selector
// only appears when there is genuinely something to decide.
function applyGamepassAvailability(gamepass) {
  if (!gamepass) return;
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

// The exit from the Game Pass route. Joining starts the membership clock, so
// the sooner a buyer does it the sooner every subsequent order becomes a
// plain transfer — which is worth stating outright rather than leaving them
// to infer it from a progress bar.
function renderRouteUnlock(group, joined) {
  const unlock = $('route-unlock');
  unlock.hidden = false;
  $('route-join-link').href = group.groupUrl || `https://www.roblox.com/groups/${Number(group.groupId)}`;

  $('route-unlock-copy').innerHTML = joined
    ? `Гишүүнчлэлийн хугацаа тоологдож байна. <strong>${Number(group.daysRemaining)} хоногийн дараа</strong> `
      + 'Robux шууд шилжих болно.'
    : 'Одоо элсвэл хугацаа өнөөдрөөс эхэлнэ. '
      + `<strong>${Number(group.requiredDays)} хоногийн дараа</strong> Robux шууд шилжих болно.`;

  $('route-join-link').textContent = joined ? 'Группээ нээх ↗' : 'Группд элсэх ↗';
  $('route-recheck-btn').hidden = joined;
}

export async function loadFulfillmentRoute() {
  const banner = $('route-banner');
  try {
    const data = await request('/order/eligibility');

    applyGamepassAvailability(data.gamepass);
    setMethod(data.route);
    banner.hidden = false;
    $('route-badge').textContent = data.route === 'group' ? 'Группээр' : 'Game Pass';
    $('route-badge').className = `badge ${data.route === 'group' ? 'badge-active' : 'badge-pending'}`;

    const group = data.group;
    const progress = $('route-progress');

    if (data.route === 'group') {
      $('route-explainer').textContent =
        'Robux группээс шууд шилжинэ.';
      progress.hidden = true;
      $('route-unlock').hidden = true;
    } else if (data.reason === 'membership_too_new' && group) {
      $('route-explainer').textContent =
        `Гишүүнчлэл ${group.requiredDays} хоног болоогүй тул одоогоор Game Pass-аар хүргэнэ.`;
      progress.hidden = false;
      const percent = Math.min(100, Math.round((group.daysInGroup / group.requiredDays) * 100));
      $('route-progress-fill').style.width = `${percent}%`;
      $('route-progress-label').textContent =
        `${group.daysInGroup} / ${group.requiredDays} хоног · ${group.daysRemaining} хоног үлдлээ`;
      renderRouteUnlock(group, true);
    } else if (data.reason === 'not_a_member' && group) {
      $('route-explainer').textContent =
        `Game Pass-аар хүргэнэ. Группд элсвэл ${group.requiredDays} хоногийн дараа шууд шилжинэ.`;
      progress.hidden = false;
      $('route-progress-fill').style.width = '0%';
      $('route-progress-label').textContent = `0 / ${group.requiredDays} хоног · Группд элсэхэд эхэлнэ`;
      renderRouteUnlock(group, false);
    } else {
      $('route-explainer').textContent = 'Robux-ийг Game Pass-аар хүргэнэ.';
      progress.hidden = true;
      $('route-unlock').hidden = true;
    }
  } catch {
    // Never block ordering on this — fall back to the route that has no
    // external precondition.
    setMethod('gamepass');
    banner.hidden = true;
  }
}

export async function loadGroupInfo() {
  try {
    const data = await request('/group-info');
    if (!data.groupId) throw new Error();
    $('group-name-display').textContent = data.groupName || `Групп #${data.groupId}`;
    $('join-group-link').href = `https://www.roblox.com/groups/${Number(data.groupId)}`;
  } catch {
    $('group-name-display').textContent = 'Тохируулагдаагүй байна';
  }
}

export function initFulfilment() {
  // "I joined — check again." Hitting /group/membership both re-checks Roblox
  // and starts the local clock for someone who joined on their own, so this is
  // the button that makes the wait begin.
  $('route-recheck-btn').addEventListener('click', async () => {
    const button = $('route-recheck-btn');
    setLoading(button, true, 'Шалгаж байна…');
    try {
      const data = await request('/group/membership', undefined, 'Шалгаж чадсангүй.');

      if (data.isMember) {
        showResult(
          $('route-recheck-result'),
          data.eligible
            ? 'Гишүүнчлэл бүрдлээ. Robux шууд шилжих боломжтой боллоо.'
            : `Гишүүнчлэл баталгаажлаа. Үлдсэн ${data.daysRemaining} хоног.`
        );
        await loadFulfillmentRoute();
      } else {
        showResult(
          $('route-recheck-result'),
          'Гишүүн болоогүй байна. Хүсэлт илгээсэн бол хэдэн минутын дараа дахин шалгана уу.',
          true
        );
      }
    } catch (error) {
      showResult($('route-recheck-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('gamepass-universe').addEventListener('change', updateCreateButtonState);
}
