// What the page shows at each stage of the sign-in funnel.
//
// Kept apart from session.js so that the modules which merely flip a flag —
// phone.js, auth.js — can redraw the page without importing the whole
// post-login boot sequence.

import { $ } from '../common/dom.js';
import { state } from './state.js';
import { applyGates } from './tabs.js';

export function updateGateVisibility() {
  // Signed out, the sales pitch and the connect card are the page.
  // Signed in, they are clutter in front of the thing you came to do.
  $('auth-card').hidden = state.isAuthenticated;
  $('marketing').hidden = state.isAuthenticated;
  $('nav-links').hidden = state.isAuthenticated;
  $('nav-cta').hidden = state.isAuthenticated;
  $('nav-toggle').hidden = state.isAuthenticated;
  $('hero-cta-row').hidden = state.isAuthenticated;
  $('account-menu').hidden = !state.isAuthenticated;

  $('phone-link-panel').hidden = !state.isAuthenticated || state.phoneLinked;
  $('order-body').hidden = !state.isAuthenticated || !state.phoneLinked;

  $('hero-package-cta').textContent = state.isAuthenticated
    ? 'Энэ багцаар захиалах →'
    : 'Энэ багцаар үргэлжлүүлэх →';

  applyGates();
}
