// /invite — the referral explainer.
//
// The only live thing on the page is the three figures at the top. They come
// from the server rather than being written into the copy, because a
// percentage typed into marketing text is a percentage that goes stale the
// first time an admin changes it, and this page's whole job is to state the
// offer accurately.

import { $ } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatNumber } from '../common/format.js';
import { initShell } from './shell.js';

initShell();

(async function loadInviteInfo() {
  try {
    const data = await request('/referral/info');

    // The programme can be switched off entirely. Saying so is better than
    // leaving three em dashes on the page for someone to puzzle over.
    if (!data.enabled) {
      $('invite-note').textContent = 'Урилгын хөтөлбөр түр хаалттай байна.';
      return;
    }

    $('invite-bonus').textContent = `+${Number(data.bonusPercent)}%`;
    $('invite-commission').textContent = `${Number(data.commissionPercent)}%`;
    $('invite-min').textContent = formatNumber(data.minPayoutRobux);
    $('invite-note').textContent =
      `Зөвхөн хүргэгдсэн захиалга тооцогдоно. Шимтгэлээ авахад доод тал нь ${formatNumber(data.minPayoutRobux)} Robux цуглуулсан байх шаардлагатай.`;
  } catch {
    // The explainer beneath is the substance of the page and stands without
    // the numbers; only the promise of exact figures is withdrawn.
    $('invite-note').textContent = 'Одоогийн хувь хэмжээг ачаалж чадсангүй. Нэвтэрсний дараа Урилга хэсгээс харна уу.';
  }
})();
