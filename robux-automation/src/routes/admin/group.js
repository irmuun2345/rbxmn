// The Roblox group Robux are paid out from, and the bot that operates it.

module.exports = function registerAdminGroupRoutes(app, { adminController }, { requireAdminAuth }) {
  app.get('/admin/group', requireAdminAuth, adminController.getGroupSettings.bind(adminController));
  app.put('/admin/group', requireAdminAuth, adminController.updateGroupSettings.bind(adminController));

  // The 14-day membership clock: who's eligible, and manual correction for
  // accounts whose recorded join date no longer reflects reality.
  app.get('/admin/group/memberships', requireAdminAuth, adminController.getGroupMemberships.bind(adminController));
  app.delete(
    '/admin/group/memberships/:userId',
    requireAdminAuth,
    adminController.resetGroupMembership.bind(adminController)
  );
  app.put(
    '/admin/group/membership-requirement',
    requireAdminAuth,
    adminController.updateMembershipRequirement.bind(adminController)
  );

  // Bot account used to accept join requests and send group payouts. The PUT
  // body carries a full Roblox session cookie, which is why nothing here ever
  // reads one back out.
  app.get('/admin/bot', requireAdminAuth, adminController.getBotStatus.bind(adminController));
  app.put('/admin/bot', requireAdminAuth, adminController.updateBotAccount.bind(adminController));
  app.delete('/admin/bot', requireAdminAuth, adminController.removeBotAccount.bind(adminController));

  // The authenticator seed that answers the bot's 2-step verification, set
  // separately from the cookie because 2FA is usually switched on after the
  // account is already connected. Write-only for the same reason as the
  // cookie: the dashboard is told whether one exists, never what it is.
  app.put('/admin/bot/two-factor', requireAdminAuth, adminController.updateBotTwoFactor.bind(adminController));
};
