// Storefront entry point.
//
// Loaded as `<script type="module">`, so it runs after the document has been
// parsed but before DOMContentLoaded — every element the init functions below
// reach for already exists.
//
// Each feature module exports one `initX()` that wires its own listeners.
// Nothing here decides what a customer is allowed to do; that is settled by
// the server on every request. What runs here only decides what is drawn.

import { initScrollReveal, initMobileNav, initCopyButtons } from '../common/page.js';
import { initTabs } from './tabs.js';
import { initAccountMenu } from './account-menu.js';
import { initPackages, loadPackages, loadPricing } from './packages.js';
import { loadEventStatus } from './events.js';
import { initPhoneLink } from './phone.js';
import { initFulfilment, setMethod } from './fulfilment.js';
import { initOrder } from './order.js';
import { initGiftCards } from './gift-cards.js';
import { initReferral } from './referral.js';
import { initAuth } from './auth.js';
import { updateGateVisibility } from './gates.js';

// Page-level decoration and the shared copy buttons.
initScrollReveal();
initMobileNav();
initCopyButtons();

// Feature listeners. initTabs also honours a #tab in the URL, so it has to
// run before anything that reads the current tab.
initTabs();
initAccountMenu();
initPackages();
initPhoneLink();
initFulfilment();
initOrder();
initGiftCards();
initReferral();
initAuth();

// Safe default until the session is known; loadFulfillmentRoute replaces it
// with the server's decision as soon as the account is linked.
setMethod('gamepass');
updateGateVisibility();

// Public data — no session needed, so it can start immediately.
loadPackages();
loadPricing();
loadEventStatus();
