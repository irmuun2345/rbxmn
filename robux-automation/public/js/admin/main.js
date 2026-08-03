// Admin dashboard entry point.
//
// Loaded as `<script type="module">`, so it runs once the document has been
// parsed. Every panel wires its own listeners through an `initX()`; the data
// only loads after /admin/profile confirms there is a live admin session.
//
// The redirect below is a convenience, not a control. Nothing on this page is
// protected by hiding it: every /admin route is behind requireAdminAuth
// server-side, and a visitor who skips the redirect still gets 401s.

import { initAccount, loadAdminProfile } from './account.js';
import { initPricing, loadPricing, loadBankAccount } from './pricing.js';
import { initOrders, loadOrders, loadAutomationStatus } from './orders.js';
import { initStalled, loadStalledOrders } from './stalled.js';
import { initGroup, loadGroupSettings, loadBotStatus, loadMemberships } from './group.js';
import { initCatalog, loadLevels, loadEvents, loadPackages } from './catalog.js';
import { initSupport, loadPhoneLinks, loadGiftCards } from './support.js';
import { initReferrals, loadReferralSettings, loadReferralCodes } from './referrals.js';
import { initAudit, loadAuditLog } from './audit.js';

initAccount();
initPricing();
initOrders();
initStalled();
initGroup();
initCatalog();
initSupport();
initReferrals();
initAudit();

// Everything the dashboard shows, fetched in parallel. Each loader reports
// its own failure into its own panel, so one dead endpoint does not blank the
// page — only a failed profile check does, and that means "not signed in".
async function boot() {
  try {
    await loadAdminProfile();
  } catch {
    window.location.replace('/admin-login.html');
    return;
  }

  await Promise.all([
    loadPricing(), loadBankAccount(),
    loadOrders(), loadAutomationStatus(), loadStalledOrders(),
    loadGroupSettings(), loadBotStatus(), loadMemberships(),
    loadLevels(), loadEvents(), loadPackages(),
    loadPhoneLinks(), loadGiftCards(),
    loadReferralSettings(), loadReferralCodes(),
    loadAuditLog()
  ]);
}

boot();
