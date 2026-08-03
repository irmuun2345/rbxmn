// Every /admin route, grouped by what the admin is actually doing.
//
// Split four ways rather than listed in one block so that "what can the
// dashboard reach?" is answerable per concern. Every route in here — with the
// single, deliberate exception of login and first-run register — sits behind
// requireAdminAuth.

const registerSessionRoutes = require('./session');
const registerQueueRoutes = require('./queue');
const registerCatalogRoutes = require('./catalog');
const registerGroupRoutes = require('./group');
const registerSupportRoutes = require('./support');

const ADMIN_ROUTE_GROUPS = [
  registerSessionRoutes,  // login, logout, profile, password
  registerQueueRoutes,    // orders, stalled deliveries, receipts, audit
  registerCatalogRoutes,  // pricing, bank details, levels, events, packages
  registerGroupRoutes,    // payout group, membership clocks, bot account
  registerSupportRoutes   // phone links, gift cards, referrals
];

module.exports = function registerAdminRoutes(app, controllers, middleware) {
  ADMIN_ROUTE_GROUPS.forEach((register) => register(app, controllers, middleware));
};
