// The account dropdown in the header.

import { $ } from '../common/dom.js';

export function setAccountMenuOpen(open) {
  $('account-trigger').setAttribute('aria-expanded', String(open));
  $('account-panel').hidden = !open;
}

export function initAccountMenu() {
  $('account-trigger').addEventListener('click', (event) => {
    // Without this the document-level handler below sees the same click and
    // closes the panel again immediately.
    event.stopPropagation();
    setAccountMenuOpen($('account-trigger').getAttribute('aria-expanded') !== 'true');
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#account-menu')) setAccountMenuOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if ($('account-trigger').getAttribute('aria-expanded') === 'true') {
      setAccountMenuOpen(false);
      $('account-trigger').focus();
    }
  });
}
