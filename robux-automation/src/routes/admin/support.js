// Customer-facing housekeeping: phone links, gift-card approvals and the
// referral programme.

module.exports = function registerAdminSupportRoutes(app, controllers, { requireAdminAuth }) {
  const { adminController, referralController } = controllers;

  // Phone <-> Roblox account links (support view + manual unlink).
  app.get('/admin/phone-links', requireAdminAuth, adminController.getPhoneLinks.bind(adminController));
  app.delete('/admin/phone-links/:userId', requireAdminAuth, adminController.unlinkPhone.bind(adminController));

  // Gift cards awaiting payment approval.
  app.get('/admin/gift-cards', requireAdminAuth, adminController.getGiftCards.bind(adminController));
  app.post('/admin/gift-cards/:id/approve', requireAdminAuth, adminController.approveGiftCard.bind(adminController));
  app.post('/admin/gift-cards/:id/reject', requireAdminAuth, adminController.rejectGiftCard.bind(adminController));

  // Referral programme: adjustable rates, creator partnerships, payouts.
  app.get('/admin/referrals/settings', requireAdminAuth, referralController.getSettings.bind(referralController));
  app.put('/admin/referrals/settings', requireAdminAuth, referralController.updateSettings.bind(referralController));
  app.get('/admin/referrals/codes', requireAdminAuth, referralController.getCodes.bind(referralController));
  // Codes are issued from here, not claimed by customers.
  app.post('/admin/referrals/codes', requireAdminAuth, referralController.issueCode.bind(referralController));
  app.put('/admin/referrals/codes/:id', requireAdminAuth, referralController.updateCodeTerms.bind(referralController));
  app.post(
    '/admin/referrals/codes/:id/payout',
    requireAdminAuth,
    referralController.recordPayout.bind(referralController)
  );
};
