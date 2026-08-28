// The invite figures on the landing page.
//
// Read from /referral/info rather than written into the markup so the pitch
// can never quote a percentage the payout path does not actually pay. No
// session is involved: this is the public half of the referral programme,
// and everything per-user lives in referral.js behind a login.

import { $ } from '../common/dom.js';
import { request } from '../common/api.js';
import { formatNumber } from '../common/format.js';

export async function loadInviteInfo() {
  try {
    const data = await request('/referral/info');

    // Switched off in admin means there is no programme to advertise. The
    // nav link goes with it rather than pointing at a hidden section.
    if (!data.enabled) {
      $('invite').hidden = true;
      document.querySelector('.nav-links a[href="#invite"]')?.remove();
      return;
    }

    $('invite-bonus').textContent = `+${Number(data.bonusPercent)}%`;
    $('invite-commission').textContent = `${Number(data.commissionPercent)}%`;

    if (data.minPayoutRobux > 0) {
      $('invite-note').textContent = 'Зөвхөн хүргэгдсэн захиалга тооцогдоно. '
        + `${formatNumber(data.minPayoutRobux)} Robux цуглармагц төлөгдөнө.`;
    }
  } catch {
    // The three steps beside these figures still explain the programme, so a
    // failed fetch costs the two numbers and nothing else — they stay on the
    // em dash they were rendered with.
  }
}
