// What the page shows at each stage of the sign-in funnel.
//
// Kept apart from session.js so that the modules which merely flip a flag —
// phone.js, auth.js — can redraw the page without importing the whole
// post-login boot sequence.

import { $ } from '../common/dom.js';
import { state } from './state.js';
import { applyGates } from './tabs.js';

export function updateGateVisibility() {
  // The two halves of the site are mutually exclusive. Signed out, the
  // landing page is the whole page and the only thing on it to do is sign
  // in; signed in, the workspace is what the visitor came back for and the
  // sales pitch is in the way of it.
  $('landing').hidden = state.isAuthenticated;
  $('workspace').hidden = !state.isAuthenticated;

  // On a phone the workspace tab strip becomes a bar fixed to the bottom of
  // the viewport, and the page has to reserve that height or the last row of
  // whatever tab is open sits underneath it. Only the signed-in page has the
  // bar, so only it pays for the space.
  document.body.classList.toggle('has-tabbar', state.isAuthenticated);

  // The marketing nav points at anchors that only exist on the landing page,
  // so it retires with it.
  $('nav-links').hidden = state.isAuthenticated;
  $('nav-cta').hidden = state.isAuthenticated;
  $('nav-toggle').hidden = state.isAuthenticated;
  $('account-menu').hidden = !state.isAuthenticated;

  // And so does the footer's copy of those anchors, which was the one place
  // they survived: five links to a hidden section under every signed-in page.
  // The workspace tabs take the slot instead.
  $('footer-nav-service').hidden = state.isAuthenticated;
  $('footer-nav-info').hidden = state.isAuthenticated;
  $('footer-nav-workspace').hidden = !state.isAuthenticated;

  // Inside the workspace, the phone link is the one step still outstanding
  // between a fresh account and an order.
  $('phone-link-panel').hidden = !state.isAuthenticated || state.phoneLinked;
  $('order-body').hidden = !state.isAuthenticated || !state.phoneLinked;

  applyGates();
}
