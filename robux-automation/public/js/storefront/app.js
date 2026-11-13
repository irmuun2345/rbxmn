// Workspace entry point — /app, the signed-in half.
//
// It boots the same feature modules the old single-document storefront did,
// and deliberately not a line of its own logic: placing an order, uploading a
// receipt, redeeming a gift card and every status poll behind them are the
// working checkout, and this page is a new set of clothes for it, not a
// rewrite. What is left out is only what belongs to the sales pitch — the
// price ladder, the marketing nav, the scroll reveals — which now live on
// the front door and the content pages.

import { $ } from '../common/dom.js';
import { initCopyButtons } from '../common/page.js';
import { initTabs, onTabShown } from './tabs.js';
import { initAccountMenu } from './account-menu.js';
import { initPackages, loadPackages, loadPricing } from './packages.js';
import { loadEvents, loadEventStatus } from './events.js';
import { initPhoneLink } from './phone.js';
import { initFulfilment, setMethod } from './fulfilment.js';
import { initOrder, onOrderChanged } from './order.js';
import { initOrders, loadOrders } from './orders.js';
import { initOrderDetail } from './order-detail.js';
import { initGiftCards, onGiftCardChanged, refreshGiftQuote } from './gift-cards.js';
import { initReferral } from './referral.js';
import { initAuth, restoreSession } from './auth.js';
import { updateGateVisibility } from './gates.js';
import { state } from './state.js';

// What each tab refreshes when it is opened. Registered before initTabs, which
// honours a #tab in the URL and fires the handler for whichever tab that is.
onTabShown('events', () => loadEvents());
onTabShown('orders', () => loadOrders({ silent: true }));
onTabShown('gift', () => refreshGiftQuote());

// Anything that moves an order — placing one, sending a receipt, a status poll
// ticking over — redraws the history, which is showing the same order.
onOrderChanged(() => loadOrders({ silent: true }));
onGiftCardChanged(() => loadOrders({ silent: true }));

initCopyButtons();
initTabs();
initAccountMenu();
initPackages();
initPhoneLink();
initFulfilment();
initOrder();
initOrders();
initOrderDetail();
initGiftCards();
initReferral();
initAuth();

// Safe default until the session is known; loadFulfillmentRoute replaces it
// with the server's decision as soon as the account is linked.
setMethod(null);
updateGateVisibility();

// Public data — no session needed, so it can start immediately.
loadPackages();
loadPricing().then(refreshGiftQuote);
loadEventStatus();

// The one thing this page adds: it is *only* the signed-in half, so a visitor
// without a session has nothing here to look at. restoreSession draws the
// workspace if the cookie is good; if it is not, the sign-in sheet opens over
// an empty page rather than leaving one.
//
// The sheet is opened rather than redirecting to the front door: arriving here
// is usually deliberate — a bookmark, or the link the front door hands a buyer
// after they pick a package — and bouncing them somewhere else loses that.
restoreSession().finally(() => {
  if (state.isAuthenticated) return;
  const sheet = $('login');
  if (!sheet.open) sheet.showModal();
});
