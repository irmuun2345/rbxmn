// The admin menu: one view on screen at a time, chosen from the sidebar.
//
// The view lives in the URL hash (#orders, #sales, …) rather than in memory,
// so a refresh, the back button and a pasted link all land on the same
// screen. Every view's data still loads at boot — switching is instant, and
// the order count in the menu is right no matter which screen is open.

const DEFAULT_VIEW = 'orders';

const views = () => [...document.querySelectorAll('[data-view]')];
const links = () => [...document.querySelectorAll('[data-view-link]')];

function viewFromHash() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  return views().some((view) => view.dataset.view === id) ? id : null;
}

function showView(id, { focus = false } = {}) {
  views().forEach((view) => { view.hidden = view.dataset.view !== id; });
  links().forEach((link) => {
    if (link.dataset.viewLink === id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  const title = document.getElementById(`view-title-${id}`);
  if (title) document.title = `${title.textContent} · rbxmn Админ`;

  if (focus) {
    window.scrollTo({ top: 0 });
    // Moves a keyboard or screen-reader user to the new screen rather than
    // leaving them in the menu with no sign anything changed.
    document.getElementById('dashboard')?.focus({ preventScroll: true });
  }
}

/**
 * The badge beside a menu item. Zero hides it: a "0" on every quiet screen
 * trains the eye to skip the one that is not zero.
 */
export function setNavCount(id, count) {
  const badge = document.getElementById(`nav-count-${id}`);
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count);
}

export function initNav() {
  // Any hash that is not a view — the skip link's #dashboard, a stale
  // bookmark — keeps whatever is on screen, or the default on first load.
  showView(viewFromHash() || DEFAULT_VIEW);

  window.addEventListener('hashchange', () => {
    const id = viewFromHash();
    if (id) showView(id, { focus: true });
  });
}
