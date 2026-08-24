// Composition root for the HTTP API.
//
// This was one 400-line function that built ten controllers and then listed
// every route in the system. The controllers are still built here — one
// place, one set of dependencies — but each group of routes now lives in the
// file named after it, so finding "where is /gift-cards/redeem defined" is a
// matter of opening gift-cards.js.
//
// Registration order is preserved from the original and matters in one place:
// the noStore blanket below has to be installed before any route it covers.

const AuthController = require('../controllers/auth-controller');
const AdminController = require('../controllers/admin-controller');
const GamePassController = require('../controllers/gamepass-controller');
const TransactionController = require('../controllers/transaction-controller');
const { PhoneController } = require('../controllers/phone-controller');
const GiftCardController = require('../controllers/giftcard-controller');
const { ReceiptController } = require('../controllers/receipt-controller');
const GroupController = require('../controllers/group-controller');
const ReferralController = require('../controllers/referral-controller');
const PaymentController = require('../controllers/payment-controller');
const ProfileController = require('../controllers/profile-controller');

const { noStore } = require('../middleware/anti-scraping');
const { PRIVATE_PATH_PREFIXES } = require('./guards');

const registerAuthRoutes = require('./auth');
const registerStorefrontRoutes = require('./storefront');
const registerAccountRoutes = require('./account');
const registerOrderRoutes = require('./orders');
const registerGiftCardRoutes = require('./gift-cards');
const registerPaymentRoutes = require('./payments');
const registerAdminRoutes = require('./admin');
const registerCronRoutes = require('./cron');

const ROUTE_GROUPS = [
  registerAuthRoutes,        // Roblox OAuth handshake and logout
  registerStorefrontRoutes,  // public catalogue: prices, packages, events
  registerAccountRoutes,     // profile, phone link, membership, referrals
  registerOrderRoutes,       // creating and paying for an order
  registerGiftCardRoutes,
  registerPaymentRoutes,     // the QPay callback
  registerAdminRoutes,
  registerCronRoutes         // the scheduled delivery sweep, called by Vercel Cron
];

module.exports = function registerRoutes(app, dependencies) {
  const { dbHelpers, RobloxAuth, requireAdminAuth, adminLogin, adminRegister } = dependencies;

  const controllers = {
    authController: new AuthController(dbHelpers, RobloxAuth),
    adminController: new AdminController(dbHelpers, adminLogin, adminRegister, RobloxAuth),
    gamepassController: new GamePassController(dbHelpers, RobloxAuth),
    transactionController: new TransactionController(dbHelpers),
    phoneController: new PhoneController(dbHelpers),
    giftCardController: new GiftCardController(dbHelpers),
    receiptController: new ReceiptController(dbHelpers),
    groupController: new GroupController(dbHelpers),
    referralController: new ReferralController(dbHelpers),
    paymentController: new PaymentController(dbHelpers),
    profileController: new ProfileController(dbHelpers)
  };

  // Every session-bearing response, so a shared cache never holds one user's
  // orders where another can be handed them. Installed first: middleware only
  // applies to routes registered after it.
  app.use(PRIVATE_PATH_PREFIXES, noStore);

  ROUTE_GROUPS.forEach((register) => register(app, controllers, { requireAdminAuth, dbHelpers }));
};
