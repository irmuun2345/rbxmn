// Orders whose payout request went to Roblox and never came back with an
// answer.
//
// Nothing here retries automatically, and it must stay that way: a payout
// that already landed must never be sent twice. A human checks the group's
// payout history on Roblox and states what actually happened.

import { $, escapeHtml, showResult } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatNumber, formatStoredDateTime } from '../common/format.js';
import { confirmDialog, askNote } from './dialog.js';
import { loadOrders } from './orders.js';
import { loadAuditLog } from './audit.js';

// What the admin is confirming, in the admin's own words, before each
// outcome is written down.
const OUTCOME_PROMPTS = {
  delivered: 'Robux очсоныг Roblox дээрээс баталгаажуулсан уу? Захиалга дууссан болно.',
  not_delivered: 'Robux ОЧООГҮЙ гэдгийг баталгаажуулсан уу? Захиалга дахин илгээгдэнэ.',
  failed: 'Амжилтгүй гэж бүртгэх үү? Төлбөрийг буцаах шаардлагатай.'
};

export async function loadStalledOrders() {
  try {
    const data = await request('/admin/orders/stalled', undefined, 'Гацсан захиалгуудыг авч чадсангүй.');
    const section = $('stalled-section');

    // Stays hidden entirely when nothing is stuck — this is an alarm, not a
    // permanent fixture.
    if (!data.orders.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    $('stalled-list').innerHTML = data.orders.map((order) => `
      <div class="editable-row">
        <div>
          <strong>#${Number(order.id)} · ${escapeHtml(order.username)} · ${formatNumber(order.amountRobux)} Robux</strong>
          <small>Roblox ID ${Number(order.robloxId)} · эхэлсэн: ${formatStoredDateTime(order.startedAt)}</small>
          ${order.paymentReference ? `<span class="ref-code">${escapeHtml(order.paymentReference)}</span>` : ''}
          ${order.error ? `<small class="reject-reason">${escapeHtml(order.error)}</small>` : ''}
        </div>
        <div class="action-buttons">
          <button class="btn btn-sm" type="button" data-resolve="delivered" data-order="${Number(order.id)}">Robux очсон</button>
          <button class="btn btn-sm btn-ghost" type="button" data-resolve="not_delivered" data-order="${Number(order.id)}">Очоогүй</button>
          <button class="btn btn-sm btn-danger" type="button" data-resolve="failed" data-order="${Number(order.id)}">Амжилтгүй</button>
        </div>
      </div>`).join('');
  } catch (error) {
    showResult($('stalled-result'), error.message, true);
  }
}

export function initStalled() {
  $('stalled-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-resolve]');
    if (!button) return;

    const outcome = button.dataset.resolve;
    const confirmed = await confirmDialog('Гацсан хүргэлтийг шийдвэрлэх', OUTCOME_PROMPTS[outcome], {
      confirmLabel: 'Тийм, баталгаажуулсан',
      danger: outcome === 'failed'
    });
    if (!confirmed) return;

    const note = await askNote(
      'Юу шалгаж, юу олсон бэ? Заавал биш.',
      'Жишээ: Группын түүхэнд бичигдсэн байсан'
    );

    button.disabled = true;
    try {
      const data = await request(
        `/admin/orders/${button.dataset.order}/resolve`,
        jsonBody('POST', { outcome, note }),
        'Захиалгыг шийдвэрлэж чадсангүй.'
      );
      showResult($('stalled-result'), data.message);
      await Promise.all([loadStalledOrders(), loadOrders(), loadAuditLog()]);
    } catch (error) {
      showResult($('stalled-result'), error.message, true);
      button.disabled = false;
    }
  });
}
