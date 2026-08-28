// The workspace tab bar, and the lock on the tabs that need a phone number
// before they will do anything.
//
// There is no signed-out state to handle here: the whole workspace is hidden
// until a session exists (see gates.js), so the only gate left is the phone
// link.
//
// What a tab *loads* when it is opened is not this module's business. It used
// to import events.js directly to refresh the promotions list; with orders
// wanting the same treatment that would have made this file the hub every
// feature passes through, and orders.js -> order.js -> tabs.js a cycle. Now
// main.js registers a handler per tab and this only announces the change.

import { $, escapeHtml } from '../common/dom.js';
import { state } from './state.js';

export const TAB_ORDER = ['buy', 'orders', 'gift', 'referral', 'events'];

// What a locked panel says. Naming the payoff matters more than naming the
// restriction — someone reading this is deciding whether the extra step is
// worth it.
const GATE_COPY = {
  gift: {
    title: 'Бэлгийн карт',
    body: 'Найздаа Robux бэлэглэхийн тулд эхлээд утасны дугаараа холбоно уу.'
  },
  referral: {
    title: 'Урилгын хөтөлбөр',
    body: 'Кодоо найздаа өгөөд шимтгэл цуглуулахын тулд утасны дугаараа холбоно уу.'
  }
};

const shownHandlers = new Map();

/** Runs `handler` every time `name` is opened. Registered from main.js. */
export function onTabShown(name, handler) {
  shownHandlers.set(name, handler);
}

export function currentTab() {
  return document.querySelector('.tab[aria-selected="true"]')?.dataset.tab || 'buy';
}

export function selectTab(name, { focusTab = false, updateHash = true } = {}) {
  if (!TAB_ORDER.includes(name)) return;

  TAB_ORDER.forEach((tabName) => {
    const tab = $(`tab-${tabName}`);
    const panel = $(`panel-${tabName}`);
    if (!tab || !panel) return;
    const selected = tabName === name;
    tab.setAttribute('aria-selected', String(selected));
    // Roving tabindex: the tablist is one tab stop, arrows move within it.
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  });

  if (focusTab) $(`tab-${name}`)?.focus();
  if (updateHash && location.hash.slice(1) !== name) {
    // replaceState rather than assigning location.hash: flipping between
    // tabs should not pile up history the back button has to chew through.
    history.replaceState(null, '', `#${name}`);
  }

  shownHandlers.get(name)?.();
}

// Locked tabs stay visible and selectable rather than vanishing: a tab that
// disappears teaches nobody that the feature exists.
export function applyGates() {
  document.querySelectorAll('.tab-panel[data-requires]').forEach((panel) => {
    const met = state.isAuthenticated && state.phoneLinked;
    const gate = panel.querySelector('[data-gate]');
    const content = panel.querySelector('[data-gated]');
    const tabName = panel.id.replace('panel-', '');

    gate.hidden = met;
    content.hidden = !met;
    $(`tab-${tabName}`).classList.toggle('is-locked', !met);

    if (met) return;

    const copy = GATE_COPY[tabName];
    gate.innerHTML = `
      <h3 class="h3">${escapeHtml(copy.title)}</h3>
      <p>${escapeHtml(copy.body)}</p>
      <button class="btn btn-primary" type="button" data-gate-action="phone">
        Утсаа холбох →
      </button>`;
  });
}

export function initTabs() {
  const tabs = document.querySelector('.tabs');

  tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) selectTab(tab.dataset.tab);
  });

  tabs.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let target = null;

    if (step) {
      const index = TAB_ORDER.indexOf(currentTab());
      target = TAB_ORDER[(index + step + TAB_ORDER.length) % TAB_ORDER.length];
    } else if (event.key === 'Home') {
      [target] = TAB_ORDER;
    } else if (event.key === 'End') {
      target = TAB_ORDER[TAB_ORDER.length - 1];
    }

    if (!target) return;
    event.preventDefault();
    selectTab(target, { focusTab: true });
  });

  // The button a locked panel renders. The phone form has a single home in
  // the Buy tab; send people there rather than duplicating it into every
  // panel that depends on it.
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-gate-action]')) return;
    selectTab('buy');
    $('phone-link-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('phone-number-input').focus();
  });

  // The footer's shortcuts into the workspace. The bare #hash on them would
  // switch the tab through the hashchange listener below, but leave the
  // viewport parked in the footer — which reads as the link having done
  // nothing. The href stays as the no-JS fallback.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-tab-link]');
    if (!link) return;
    event.preventDefault();
    selectTab(link.dataset.tabLink);
    document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // A tab in the URL survives a refresh and can be linked to directly —
  // "look at the events tab" has to be a shareable thing.
  const hashTab = location.hash.slice(1);
  selectTab(TAB_ORDER.includes(hashTab) ? hashTab : 'buy', { updateHash: false });

  window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (TAB_ORDER.includes(name)) selectTab(name, { updateHash: false });
  });
}
