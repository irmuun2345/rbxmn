// Getting into the dashboard, and staying there.

const { loginLimiter } = require('../../middleware/anti-scraping');

module.exports = function registerAdminSessionRoutes(app, { adminController }, { requireAdminAuth }) {
  // Password guessing is the single highest-value attack on this system — the
  // dashboard can approve payouts — so this is limited hardest.
  app.post('/admin/login', loginLimiter, adminController.login.bind(adminController));

  // First-run setup only: the controller refuses once an admin exists, and
  // the limiter stops the endpoint being used to probe for that.
  app.post('/admin/register', loginLimiter, adminController.register.bind(adminController));

  app.post('/admin/logout', requireAdminAuth, adminController.logout.bind(adminController));
  app.get('/admin/profile', requireAdminAuth, adminController.getProfile.bind(adminController));
  app.put('/admin/password', requireAdminAuth, adminController.changePassword.bind(adminController));

  app.get(
    '/admin/automation-status',
    requireAdminAuth,
    adminController.getAutomationStatus.bind(adminController)
  );
};
