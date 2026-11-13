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
  // The linked Roblox username. Only used to label the Messenger hand-off.
  username: '',

  // Fulfilment: 'group' (bot pays out from group funds), 'gamepass', or
  // 'manual' (an admin delivers by hand after a Messenger chat).
  // Chosen by the server, never by the buyer — see fulfilment.js.
  // Null until /order/eligibility answers.
  method: null,
  // Our Messenger page, as the server reports it. Null until known, and
  // null for good if it is not configured.
  messengerUrl: null,
  authorizedUniverseIds: [],
  // True when the server reports the Game Pass route as closed platform-side,
  // which is a different situation from a buyer who granted no experience:
  // nothing the buyer does reopens it.
  gamepassDisabled: false,
  // Per granted experience: is it public and rated high enough to carry a
  // pass? Keyed by universe id, filled from /gamepass/readiness. Advisory —
  // the server re-checks at order time.
  experienceReadiness: {},
  requiredAge: 16,

  // Catalogue, and which entry the Buy tab's picker has selected. There is
  // no gift equivalent: a gift card takes a typed amount, not a package.
  packages: [],
  selectedOrderPackageId: null,

  // MNT per 100 Robux, as /pricing reports it. Nothing renders it directly;
  // the gift card quote is computed from it.
  pricePer100: 0,

  // Loyalty discount, applied to displayed prices only. The server applies
  // its own copy when the order is actually priced.
  levelDiscountPercent: 0,

  // The order whose payment panel is on screen, and the timer polling it.
  orderId: null,
  paymentPollTimer: null,

  // Every purchase this customer has ever made — orders and gift cards both,
  // newest first and flattened into one shape by orders.js. Held here rather
  // than refetched per redraw so filtering and paging the history is free.
  orders: []
};
