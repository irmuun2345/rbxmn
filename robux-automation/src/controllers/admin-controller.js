// Composition root for the admin dashboard's request handlers.
//
// This was a single class with 45 methods spanning six unrelated concerns.
// Each concern now lives in its own file under admin/, and they are composed
// onto one prototype here.
//
// Mixins rather than sub-controllers, deliberately: the handlers share `this`
// (dbHelpers, RobloxAuth, getSettingValue) and a few call each other —
// markOrderPurchased delegates to checkGroupDelivery — so composing onto a
// single prototype keeps every one of those references working exactly as it
// did. Nothing about the public shape changed, which is why the route files
// in src/routes/admin/ can bind straight to it: `new AdminController(...)`
// still answers to all 45 handlers.
//
// Adding a concern means adding a file and one line to MIXINS.
const authHandlers = require('./admin/auth');
const storefrontHandlers = require('./admin/storefront');
const groupHandlers = require('./admin/group');
const orderHandlers = require('./admin/orders');
const catalogHandlers = require('./admin/catalog');
const supportHandlers = require('./admin/support');

const MIXINS = [
  authHandlers,
  storefrontHandlers,
  groupHandlers,
  orderHandlers,
  catalogHandlers,
  supportHandlers
];

class AdminController {
  constructor(dbHelpers, adminLogin, adminRegister, RobloxAuth) {
    this.dbHelpers = dbHelpers;
    this.adminLogin = adminLogin;
    this.adminRegister = adminRegister;
    this.RobloxAuth = RobloxAuth;
  }

  // Shared by nearly every handler, so it stays on the base rather than in
  // any one mixin.
  getSettingValue(key) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getSetting(key, (error, row) => (error ? reject(error) : resolve(row?.value || '')));
    });
  }
}

// Two mixins defining the same handler would silently shadow one another, and
// which one won would depend on list order. Checked at require time so it
// fails at boot instead of serving the wrong handler.
MIXINS.forEach((mixin) => {
  Object.entries(mixin).forEach(([name, handler]) => {
    if (Object.prototype.hasOwnProperty.call(AdminController.prototype, name)) {
      throw new Error(`Duplicate admin handler "${name}" — two mixins define it.`);
    }
    AdminController.prototype[name] = handler;
  });
});

module.exports = AdminController;
