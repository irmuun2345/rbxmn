// Storefront configuration: what things cost, what is sold, and where the
// money is sent.

module.exports = function registerAdminCatalogRoutes(app, { adminController }, { requireAdminAuth }) {
  app.put('/admin/pricing', requireAdminAuth, adminController.updatePricing.bind(adminController));

  // The bank accounts customers transfer payment into. Several, so a buyer can
  // pick one inside their own bank; the order they are listed in is the order
  // buyers see them, hence the reorder endpoint.
  app.get('/admin/bank-accounts', requireAdminAuth, adminController.listAllBankAccounts.bind(adminController));
  app.post('/admin/bank-accounts', requireAdminAuth, adminController.createBankAccount.bind(adminController));
  app.put('/admin/bank-accounts/order', requireAdminAuth, adminController.reorderBankAccounts.bind(adminController));
  app.put('/admin/bank-accounts/:id', requireAdminAuth, adminController.updateBankAccount.bind(adminController));
  app.delete('/admin/bank-accounts/:id', requireAdminAuth, adminController.deleteBankAccount.bind(adminController));

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
