// The four-tab workspace, and the locks on the tabs a visitor has not earned
// access to yet.

import { $, escapeHtml } from '../common/dom.js';
import { state } from './state.js';
import { loadEvents } from './events.js';

export const TAB_ORDER = ['buy', 'gift', 'referral', 'events'];

// What a locked panel says. Naming the payoff matters more than naming the
// restriction — someone who has not signed up is reading this to decide
// whether doing so is worth it.
const GATE_COPY = {
  buy: {
    auth: {
      title: 'Robux авах',
      body: 'Багцаа сонгоод банкаар төлнө. Нууц үг асуухгүй.'
    }
  },
  gift: {
    auth: {
      title: 'Бэлгийн карт',
      body: 'Найздаа Robux бэлэглэ. Код нэг удаа ажиллана.'
    },
    phone: {
      title: 'Бэлгийн карт',
      body: 'Эхлээд утасны дугаараа холбоно уу.'
    }
  },
  referral: {
    auth: {
      title: 'Урилгын хөтөлбөр',
      body: 'Кодоо найздаа өг — тэр илүү Robux авч, та шимтгэл цуглуулна.'
    },
    phone: {
      title: 'Урилгын хөтөлбөр',
      body: 'Эхлээд утасны дугаараа холбоно уу.'
    }
  }
};

export function currentTab() {
  return document.querySelector('.tab[aria-selected="true"]')?.dataset.tab || 'buy';
}

export function selectTab(name, { focusTab = false, updateHash = true } = {}) {
  if (!TAB_ORDER.includes(name)) return;

  TAB_ORDER.forEach((tabName) => {
    const tab = $(`tab-${tabName}`);
    const panel = $(`panel-${tabName}`);
    const selected = tabName === name;
    tab.setAttribute('aria-selected', String(selected));
    // Roving tabindex: the tablist is one tab stop, arrows move within it.
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  });

  if (focusTab) $(`tab-${name}`).focus();
  if (updateHash && location.hash.slice(1) !== name) {
    // replaceState rather than assigning location.hash: flipping between
    // tabs should not pile up history the back button has to chew through.
    history.replaceState(null, '', `#${name}`);
  }
  if (name === 'events') loadEvents();
}

// Locked tabs stay visible and selectable rather than vanishing: a tab that
// disappears teaches nobody that the feature exists.
export function applyGates() {
  document.querySelectorAll('.tab-panel[data-requires]').forEach((panel) => {
    const met = panel.dataset.requires === 'auth'
      ? state.isAuthenticated
      : (state.isAuthenticated && state.phoneLinked);
    const gate = panel.querySelector('[data-gate]');
    const content = panel.querySelector('[data-gated]');
    const tabName = panel.id.replace('panel-', '');

    gate.hidden = met;
    content.hidden = !met;
    $(`tab-${tabName}`).classList.toggle('is-locked', !met);

    if (met) return;

    const reason = state.isAuthenticated ? 'phone' : 'auth';
    const copy = GATE_COPY[tabName][reason] || GATE_COPY[tabName].auth;
    gate.innerHTML = `
      <h3 class="h3">${escapeHtml(copy.title)}</h3>
      <p>${escapeHtml(copy.body)}</p>
      <button class="btn btn-primary" type="button" data-gate-action="${reason}">
        ${reason === 'auth' ? 'Roblox-оор холбогдох →' : 'Утсаа холбох →'}
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

  // The button a locked panel renders. Sends the visitor to whichever step
  // they are actually missing.
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-gate-action]');
    if (!action) return;
    if (action.dataset.gateAction === 'auth') {
      $('auth-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      // The phone form has a single home in the Buy tab; send people there
      // rather than duplicating it into every panel that depends on it.
      selectTab('buy');
      $('phone-link-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('phone-number-input').focus();
    }
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
