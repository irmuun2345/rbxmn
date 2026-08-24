// Everything the storefront modules need to know about each other.
//
// One object rather than a scatter of exported `let`s: an imported binding
// cannot be reassigned from the importing module, so shared mutable values
// have to hang off something. Keeping them together also makes the whole of
// the page's client-side state readable in one screen.
//
// None of this is trusted. Prices, levels, bonuses and order status are
// recomputed server-side on every request; what is held here only decides
// what the page draws.
export const state = {
  // Roblox OAuth handshake in progress, if any, and the timer polling it.
  sessionId: null,
  authPollTimer: null,

  // Set once the session cookie is known to be good.
  isAuthenticated: false,
  phoneLinked: false,

  // Fulfilment: 'group' (bot pays out from group funds) or 'gamepass'.
  // Chosen by the server, never by the buyer — see fulfilment.js.
  method: 'group',
  authorizedUniverseIds: [],

  // Catalogue, and which entry each of the two pickers has selected.
  packages: [],
  selectedOrderPackageId: null,
  selectedGiftPackageId: null,

  // Loyalty discount, applied to displayed prices only. The server applies
  // its own copy when the order is actually priced.
  levelDiscountPercent: 0,

  // The order whose payment panel is on screen, and the timer polling it.
  orderId: null,
  paymentPollTimer: null
};
