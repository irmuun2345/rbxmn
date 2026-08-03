// Storefront configuration: what things cost, what is sold, and where the
// money is sent.

module.exports = function registerAdminCatalogRoutes(app, { adminController }, { requireAdminAuth }) {
  app.put('/admin/pricing', requireAdminAuth, adminController.updatePricing.bind(adminController));

  // The bank account customers transfer payment to.
  app.put('/admin/bank-account', requireAdminAuth, adminController.updateBankAccount.bind(adminController));

  // Loyalty level thresholds (based on lifetime Robux purchased).
  app.get('/admin/levels', requireAdminAuth, adminController.getLevels.bind(adminController));
  app.put('/admin/levels', requireAdminAuth, adminController.updateLevels.bind(adminController));

  // Time-boxed bonus events.
  app.get('/admin/events', requireAdminAuth, adminController.getEvents.bind(adminController));
  app.post('/admin/events', requireAdminAuth, adminController.createEvent.bind(adminController));
  app.delete('/admin/events/:id', requireAdminAuth, adminController.deleteEvent.bind(adminController));

  // Fixed Robux packages (amount, price, event discount).
  app.get('/admin/packages', requireAdminAuth, adminController.getPackages.bind(adminController));
  app.post('/admin/packages', requireAdminAuth, adminController.createPackage.bind(adminController));
  app.put('/admin/packages/:id', requireAdminAuth, adminController.updatePackage.bind(adminController));
  app.delete('/admin/packages/:id', requireAdminAuth, adminController.deletePackage.bind(adminController));
};
