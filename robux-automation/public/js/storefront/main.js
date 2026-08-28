// Storefront entry point.
//
// Loaded as `<script type="module">`, so it runs after the document has been
// parsed but before DOMContentLoaded — every element the init functions below
// reach for already exists.
//
// Each feature module exports one `initX()` that wires its own listeners.
// Nothing here decides what a customer is allowed to do; that is settled by
// the server on every request. What runs here only decides what is drawn.

import {
  initScrollReveal, initStickyHeader, initScrollSpy, initMobileNav, initCopyButtons
} from '../common/page.js';
import { initTabs, onTabShown } from './tabs.js';
import { initAccountMenu } from './account-menu.js';
import { initPackages, loadPackages, loadPricing } from './packages.js';
import { loadEvents, loadEventStatus } from './events.js';
import { loadInviteInfo } from './invite.js';
import { initPhoneLink } from './phone.js';
import { initFulfilment, setMethod } from './fulfilment.js';
import { initOrder, onOrderChanged } from './order.js';
import { initOrders, loadOrders } from './orders.js';
import { initOrderDetail } from './order-detail.js';
import { initGiftCards, onGiftCardChanged, refreshGiftQuote } from './gift-cards.js';
import { initReferral } from './referral.js';
import { initAuth, restoreSession } from './auth.js';
import { updateGateVisibility } from './gates.js';

// Page-level decoration, navigation state and the shared copy buttons.
initScrollReveal();
initStickyHeader();
initScrollSpy();
initMobileNav();
initCopyButtons();

// What each tab refreshes when it is opened. Registered here rather than
// imported by tabs.js so that module stays a tab bar and not the hub every
// feature has to route through — see the note at the top of tabs.js.
onTabShown('events', () => loadEvents());
onTabShown('orders', () => loadOrders({ silent: true }));
// The quote is computed from the rate and the buyer's level discount, both of
// which arrive from their own requests after this panel was first drawn.
onTabShown('gift', () => refreshGiftQuote());

// Anything that moves an order — placing one, sending a receipt, a status
// poll ticking over — redraws the history, which is showing the same order.
onOrderChanged(() => loadOrders({ silent: true }));

// Gift cards are rows in that same history, so buying or redeeming one has to
// redraw it too. Routed through main.js rather than imported directly because
// orders.js already reaches into gift-cards.js the other way.
onGiftCardChanged(() => loadOrders({ silent: true }));

// Feature listeners. initTabs also honours a #tab in the URL and fires the
// handler for whichever tab that is, so it has to run after the handlers
// above are registered.
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
setMethod('gamepass');
updateGateVisibility();

// Public data — no session needed, so it can start immediately. Events are
// fetched up front rather than on first click of the Events tab because the
// landing page carries the same list, above the sign-in line.
loadPackages();
// The rate the gift card quote is priced from; nothing draws it on its own.
loadPricing().then(refreshGiftQuote);
loadEvents();
loadEventStatus();
loadInviteInfo();

// A session cookie survives the page, so the workspace — not the sales
// pitch — is what a returning customer should be looking at. Runs last:
// everything above it draws the signed-out page, and this replaces it if
// the server says there is a session.
restoreSession();
