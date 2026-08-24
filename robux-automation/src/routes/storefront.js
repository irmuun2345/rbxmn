// Everything a visitor can read without signing in: prices, packages, events
// and the payment details shown once an order exists.
//
// All of it goes through the `publicData` chain — see guards.js for why.

const { publicData } = require('./guards');

module.exports = function registerStorefrontRoutes(app, { adminController }) {
  // Handled by adminController because these read the same settings rows the
  // dashboard writes; the read side just has no auth requirement.
  app.get('/pricing', publicData, adminController.getPricing.bind(adminController));

  // Bank transfer details, shown once an order is created. Every active
  // account, so the buyer can pick one at their own bank.
  app.get('/bank-account', publicData, adminController.listBankAccounts.bind(adminController));

  // Group info, shown for the group-payout delivery method.
  app.get('/group-info', publicData, adminController.getGroupSettings.bind(adminController));

  // Is a bonus event currently running? Drives the header banner.
  app.get('/event-status', publicData, adminController.getEventStatus.bind(adminController));

  // Running and upcoming events plus today's discounted packages.
  app.get('/events', publicData, adminController.getPublicEvents.bind(adminController));

  // Fixed Robux packages — the only amounts customers can buy or gift.
  app.get('/packages', publicData, adminController.getPublicPackages.bind(adminController));
};
