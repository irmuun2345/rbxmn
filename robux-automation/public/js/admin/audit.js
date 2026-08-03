// The append-only record of who did what.
//
// Read-only by design: there is no route that edits or deletes an entry, and
// this file offers no control that would call one.

import { $, escapeHtml, showResult } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatStoredDateTime } from '../common/format.js';

const ACTION_LABELS = {
  'admin.login': 'Админ нэвтэрсэн',
  'admin.login_failed': 'Нэвтрэх оролдлого амжилтгүй',
  'admin.logout': 'Админ гарсан',
  'admin.password_changed': 'Нууц үг солигдсон',
  'order.under_review': 'Захиалга шалгаж эхэлсэн',
  'order.payment_approved': 'Төлбөр зөвшөөрсөн',
  'order.payment_rejected': 'Төлбөр татгалзсан',
  'order.fulfilled': 'Хүргэлт дууссан',
  'order.fulfillment_failed': 'Хүргэлт амжилтгүй',
  'order.marked_failed': 'Захиалга амжилтгүй болгосон',
  'receipt.submitted': 'Баримт илгээсэн',
  'receipt.duplicate_blocked': 'Давхардсан баримт хаагдсан',
  'receipt.viewed': 'Баримт үзсэн',
  'gift_card.approved': 'Бэлгийн карт зөвшөөрсөн',
  'gift_card.rejected': 'Бэлгийн карт татгалзсан',
  'gift_card.redeemed': 'Бэлгийн карт ашигласан',
  'group.join_accepted': 'Группд элсүүлсэн',
  'group.membership_reset': 'Гишүүнчлэл шинэчилсэн',
  'setting.updated': 'Тохиргоо өөрчлөгдсөн',
  'package.created': 'Багц үүсгэсэн',
  'package.updated': 'Багц зассан',
  'package.deleted': 'Багц устгасан',
  'event.created': 'Эвент үүсгэсэн',
  'event.deleted': 'Эвент устгасан',
  'phone.unlinked': 'Утас салгасан',
  'bot.account_updated': 'Bot аккаунт солигдсон',
  'bot.account_removed': 'Bot аккаунт салгасан'
};

// Actions that either move money or change who can receive it. Marked so
// they're findable at a glance in a long list.
const CRITICAL = new Set([
  'order.payment_approved', 'order.payment_rejected', 'order.fulfilled',
  'order.fulfillment_failed', 'receipt.duplicate_blocked',
  'group.membership_reset', 'admin.login_failed'
]);

export async function loadAuditLog() {
  try {
    const action = $('audit-filter').value;
    const query = action ? `?limit=100&action=${encodeURIComponent(action)}` : '?limit=100';
    const data = await request(`/admin/audit-log${query}`, undefined, 'Аудит бүртгэлийг авч чадсангүй.');

    if (!data.entries.length) {
      $('audit-list').innerHTML = '<p class="hint">Бүртгэл алга.</p>';
      return;
    }

    $('audit-list').innerHTML = data.entries.map((entry) => {
      const label = ACTION_LABELS[entry.action] || entry.action;
      const target = entry.entityType
        ? `${escapeHtml(entry.entityType)}${entry.entityId ? ` #${Number(entry.entityId)}` : ''}`
        : '—';
      return `
        <div class="editable-row audit-row${CRITICAL.has(entry.action) ? ' is-critical' : ''}">
          <div>
            <strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(entry.actorName || entry.actorType)} · ${target} · ${formatStoredDateTime(entry.createdAt)}</small>
            ${entry.details ? `<small class="audit-details">${escapeHtml(JSON.stringify(entry.details))}</small>` : ''}
          </div>
          <div><span class="badge ${entry.actorType === 'system' ? 'badge-pending' : 'badge-active'}">${escapeHtml(entry.actorType)}</span></div>
        </div>`;
    }).join('');
  } catch (error) {
    showResult($('audit-result'), error.message, true);
  }
}

export function initAudit() {
  $('audit-filter').addEventListener('change', loadAuditLog);
}
