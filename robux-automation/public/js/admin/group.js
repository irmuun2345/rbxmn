// The Roblox group Robux are paid out from: which group it is, the bot
// account that operates it, and each buyer's membership clock.

import { $, escapeHtml, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatStoredDateTime } from '../common/format.js';
import { confirmDialog } from './dialog.js';

export async function loadGroupSettings() {
  try {
    const data = await request('/admin/group', undefined, 'Группын мэдээлэл авч чадсангүй.');
    $('group-id-input').value = data.groupId;
    $('group-name-status').textContent = data.groupId
      ? `Одоогийн групп: ${data.groupName || `#${data.groupId}`}`
      : 'Тохируулагдаагүй байна.';
  } catch (error) {
    $('group-name-status').textContent = error.message;
  }
}

export async function loadBotStatus() {
  try {
    const data = await request('/admin/bot', undefined, 'Bot-ийн мэдээлэл авч чадсангүй.');
    $('bot-status').textContent = data.connected
      ? `Холбогдсон: ${data.username} (ID ${data.robloxId})`
      : 'Холбогдоогүй байна.';
    // The server reports whether a secret exists, never what it is.
    $('bot-2fa-status').textContent = data.twoFactorReady
      ? 'Тохируулсан. Roblox 2FA асуувал систем өөрөө хариулна.'
      : 'Тохируулаагүй байна. Bot дээр 2FA асаалттай бол payout зогсоно.';
  } catch (error) {
    $('bot-status').textContent = error.message;
  }
}

export async function loadMemberships() {
  try {
    const data = await request('/admin/group/memberships', undefined, 'Гишүүнчлэлийн мэдээлэл авч чадсангүй.');
    if (!data.memberships.length) {
      $('memberships-list').innerHTML = '<p class="hint">Бүртгэгдсэн гишүүнчлэл алга.</p>';
      return;
    }
    $('memberships-list').innerHTML = data.memberships.map((member) => `
      <div class="editable-row">
        <div>
          <strong>${escapeHtml(member.username)}</strong>
          <small>${Number(member.daysInGroup)} / ${Number(data.requiredDays)} хоног · ${member.source === 'accepted' ? 'Бид элсүүлсэн' : 'Тэмдэглэсэн'} · ${formatStoredDateTime(member.joinedAt)}</small>
        </div>
        <div class="action-buttons">
          <span class="badge ${member.eligible ? 'badge-active' : 'badge-pending'}">${member.eligible
            ? 'Боломжтой'
            : `${Number(data.requiredDays) - Number(member.daysInGroup)} хоног үлдсэн`}</span>
          <button class="btn btn-sm btn-danger" type="button" data-reset-membership="${Number(member.userId)}">Хугацаа шинэчлэх</button>
        </div>
      </div>`).join('');
  } catch (error) {
    showResult($('memberships-result'), error.message, true);
  }
}

function initGroupForm() {
  $('save-group-btn').addEventListener('click', async () => {
    const button = $('save-group-btn');
    setLoading(button, true, 'Хадгалж байна…');
    try {
      const data = await request(
        '/admin/group',
        jsonBody('PUT', { groupId: $('group-id-input').value.trim() }),
        'Группын ID шалгаж чадсангүй.'
      );
      $('group-name-status').textContent = `Одоогийн групп: ${data.groupName}`;
      showResult($('group-result'), 'Группын мэдээлэл хадгалагдлаа.');
    } catch (error) {
      showResult($('group-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}

function initBotAccount() {
  $('connect-bot-btn').addEventListener('click', async () => {
    const cookie = $('bot-cookie-input').value.trim();
    if (!cookie) {
      showResult($('bot-result'), 'Cookie утгаа оруулна уу.', true);
      return;
    }
    const button = $('connect-bot-btn');
    setLoading(button, true, 'Холбож байна…');
    try {
      const data = await request('/admin/bot', jsonBody('PUT', { cookie }), 'Bot холбож чадсангүй.');
      // Cleared immediately: this is a full Roblox session cookie, and there
      // is no reason for it to sit in a DOM node after it has been sent.
      $('bot-cookie-input').value = '';
      $('bot-status').textContent = `Холбогдсон: ${data.username} (ID ${data.robloxId})`;
      showResult($('bot-result'), 'Bot аккаунт амжилттай холбогдлоо.');
    } catch (error) {
      showResult($('bot-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('save-bot-2fa-btn').addEventListener('click', async () => {
    const totpSecret = $('bot-totp-input').value.trim();
    if (!totpSecret) {
      showResult($('bot-2fa-result'), 'Authenticator секретээ оруулна уу.', true);
      return;
    }
    const button = $('save-bot-2fa-btn');
    setLoading(button, true, 'Хадгалж байна…');
    try {
      await request('/admin/bot/two-factor', jsonBody('PUT', { totpSecret }), '2FA секрет хадгалж чадсангүй.');
      // Same reasoning as the cookie above: this is the seed to the bot's
      // second factor, and it has no business sitting in a DOM node.
      $('bot-totp-input').value = '';
      showResult($('bot-2fa-result'), '2FA секрет хадгалагдлаа.');
      await loadBotStatus();
    } catch (error) {
      showResult($('bot-2fa-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('clear-bot-2fa-btn').addEventListener('click', async () => {
    const confirmed = await confirmDialog(
      '2FA секрет устгах',
      'Bot дээр 2FA асаалттай хэвээр бол дараагийн payout амжилтгүй болж, захиалга дараалалд буцна.',
      { confirmLabel: 'Устгах', danger: true }
    );
    if (!confirmed) return;

    const button = $('clear-bot-2fa-btn');
    button.disabled = true;
    try {
      await request('/admin/bot/two-factor', jsonBody('PUT', { totpSecret: '' }), '2FA секрет устгаж чадсангүй.');
      showResult($('bot-2fa-result'), '2FA секрет устгагдлаа.');
      await loadBotStatus();
    } catch (error) {
      showResult($('bot-2fa-result'), error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('disconnect-bot-btn').addEventListener('click', async () => {
    const button = $('disconnect-bot-btn');
    button.disabled = true;
    try {
      await request('/admin/bot', { method: 'DELETE' }, 'Bot салгаж чадсангүй.');
      $('bot-status').textContent = 'Холбогдоогүй байна.';
      showResult($('bot-result'), 'Bot аккаунтын холболт салгагдлаа.');
    } catch (error) {
      showResult($('bot-result'), error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function initMemberships() {
  $('memberships-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-reset-membership]');
    if (!button) return;

    const confirmed = await confirmDialog(
      'Гишүүнчлэлийн хугацааг шинэчлэх',
      'Хүлээх хугацаа өнөөдрөөс дахин эхэлнэ.',
      { confirmLabel: 'Шинэчлэх', danger: true }
    );
    if (!confirmed) return;

    button.disabled = true;
    try {
      await request(
        `/admin/group/memberships/${button.dataset.resetMembership}`,
        { method: 'DELETE' },
        'Шинэчилж чадсангүй.'
      );
      showResult($('memberships-result'), 'Гишүүнчлэлийн хугацаа шинэчлэгдлээ.');
      await loadMemberships();
    } catch (error) {
      showResult($('memberships-result'), error.message, true);
      button.disabled = false;
    }
  });
}

export function initGroup() {
  initGroupForm();
  initBotAccount();
  initMemberships();
}
