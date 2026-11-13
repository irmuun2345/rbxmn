// What the page shows at each stage of the sign-in funnel.
//
// Kept apart from session.js so that the modules which merely flip a flag —
// phone.js, auth.js — can redraw the page without importing the whole
// post-login boot sequence.
//
// Every element named here is page-specific: the old single-document
// storefront carries all of them, /app carries only the workspace half, and
// neither should throw on the other's ids. Hence setHidden throughout.

import { setHidden } from '../common/dom.js';
import { state } from './state.js';
import { applyGates } from './tabs.js';

export function updateGateVisibility() {
  // The two halves of the site are mutually exclusive. Signed out, the
  // landing page is the whole page and the only thing on it to do is sign
  // in; signed in, the workspace is what the visitor came back for and the
  // sales pitch is in the way of it.
  setHidden('landing', state.isAuthenticated);
  setHidden('workspace', !state.isAuthenticated);

  // On a phone the workspace tab strip becomes a bar fixed to the bottom of
  // the viewport, and the page has to reserve that height or the last row of
  // whatever tab is open sits underneath it. Only the signed-in page has the
  // bar, so only it pays for the space.
  document.body.classList.toggle('has-tabbar', state.isAuthenticated);

  // The marketing nav points at anchors that only exist on the landing page,
  // so it retires with it.
  setHidden('nav-links', state.isAuthenticated);
  setHidden('nav-cta', state.isAuthenticated);
  setHidden('nav-toggle', state.isAuthenticated);
  setHidden('account-menu', !state.isAuthenticated);

  // And so does the footer's copy of those anchors, which was the one place
  // they survived: five links to a hidden section under every signed-in page.
  // The workspace tabs take the slot instead.
  setHidden('footer-nav-service', state.isAuthenticated);
  setHidden('footer-nav-info', state.isAuthenticated);
  setHidden('footer-nav-workspace', !state.isAuthenticated);

  // Inside the workspace, the phone link is the one step still outstanding
  // between a fresh account and an order.
  setHidden('phone-link-panel', !state.isAuthenticated || state.phoneLinked);
  setHidden('order-body', !state.isAuthenticated || !state.phoneLinked);

  applyGates();
}
