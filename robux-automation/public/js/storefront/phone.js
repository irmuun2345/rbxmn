// Linking a phone number to the signed-in Roblox account.
//
// One number per account is what stops a single person spreading discounts
// and referral bonuses across a farm of Roblox accounts; the uniqueness is
// enforced by a database index, not here.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { state } from './state.js';
import { updateGateVisibility } from './gates.js';
import { refreshGiftQuote } from './gift-cards.js';

export async function checkPhoneStatus() {
  try {
    const data = await request('/phone/status');
    state.phoneLinked = Boolean(data.linked);
  } catch {
    state.phoneLinked = false;
  }
  updateGateVisibility();
}

export function initPhoneLink() {
  $('link-phone-btn').addEventListener('click', async () => {
    const button = $('link-phone-btn');
    const phoneNumber = $('phone-number-input').value.trim();
    setLoading(button, true, 'Холбож байна…');
    try {
      await request(
        '/phone/link',
        jsonBody('POST', { phoneNumber }),
        'Утасны дугаар холбогдсонгүй.'
      );
      state.phoneLinked = true;
      updateGateVisibility();
      showResult($('phone-link-result'), 'Утасны дугаар холбогдлоо.');
      // The gift panel was gated until a moment ago; draw its quote now that
      // the buyer can actually see it.
      refreshGiftQuote();
    } catch (error) {
      showResult($('phone-link-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}
