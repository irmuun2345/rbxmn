// What a signed-in customer can see and change about their own account:
// profile, phone link, group-membership clock and referral code.

const { noStore, codeLimiter, writeLimiter, publicDataLimiter } = require('../middleware/anti-scraping');
const { requireAuth } = require('./guards');

module.exports = function registerAccountRoutes(app, controllers) {
  const { profileController, phoneController, groupController, referralController } = controllers;

  app.get('/profile', requireAuth, profileController.getProfile.bind(profileController));

  // Is this Roblox account's phone already linked? Gates the order and
  // gift-card UI.
  app.get('/phone/status', requireAuth, phoneController.getStatus.bind(phoneController));
  app.post('/phone/link', requireAuth, phoneController.link.bind(phoneController));

  // The buyer's 14-day payout clock: whether they're in the group, since
  // when, and how many days remain. Calling it also starts the clock for
  // someone who joined the group on their own.
  app.get('/group/membership', requireAuth, groupController.getMembership.bind(groupController));

  // Which fulfillment route this buyer gets. The server decides; the client
  // only renders the answer.
  app.get('/order/eligibility', requireAuth, groupController.getFulfillmentRoute.bind(groupController));

  // ---- Referrals -----------------------------------------------------------

  // Anyone can have a code; the code itself is self-chosen and unique.
  app.get('/referral/me', requireAuth, noStore, referralController.getMine.bind(referralController));

  // Availability is a lookup over every existing code, so unlimited access to
  // it enumerates the whole referral namespace. It answers 200 either way,
  // though, so codeLimiter (which only counts failures) would never fire —
  // this needs a limiter that counts every call.
  app.get(
    '/referral/available/:code',
    publicDataLimiter,
    requireAuth,
    referralController.checkAvailability.bind(referralController)
  );

  app.post('/referral/code', writeLimiter, requireAuth, referralController.createCode.bind(referralController));

  // Applying a code takes someone else's code as input, so it is guessable in
  // a way creating one is not — it gets the tighter limiter.
  app.post('/referral/apply', codeLimiter, requireAuth, referralController.applyCode.bind(referralController));
};
