// The manual delivery route: an order that a person finishes by hand.
//
// Neither automatic route can serve most buyers today. Roblox gives no way to
// send a group join request on someone's behalf, so the group payout only
// reaches buyers who already joined and waited out the membership clock; and
// cross-game pass sales are closed (see gamepass-route.js). Everyone else gets
// this route: the order is created and priced exactly like the others, the
// buyer is handed straight to our Messenger page with its reference code, and
// an admin delivers from the chat and closes the order in the queue.
//
// The Messenger link is configuration, not code: MESSENGER_URL, e.g.
// https://m.me/yourpage. Read per call for the same reason gamepass-route.js
// reads its flag per call.

// Only links that actually open a Messenger conversation. The URL is handed
// to every buyer's browser, so a typo'd or hostile value must fail closed
// rather than send people somewhere else.
const MESSENGER_HOSTS = ['m.me', 'www.m.me', 'messenger.com', 'www.messenger.com'];

function messengerUrl() {
  const raw = String(process.env.MESSENGER_URL || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !MESSENGER_HOSTS.includes(url.hostname)) return null;
    if (url.pathname === '/' || url.pathname === '') return null;
    // Any query the admin pasted is dropped; the storefront appends its own.
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const MESSENGER_NOT_CONFIGURED_MESSAGE =
  'Үйлчилгээ түр хугацаанд боломжгүй байна. Дэмжлэгтэй холбогдоно уу.';

module.exports = {
  messengerUrl,
  MESSENGER_NOT_CONFIGURED_MESSAGE
};
