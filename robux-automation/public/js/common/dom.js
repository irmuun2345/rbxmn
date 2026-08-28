// The handful of DOM helpers every page reaches for.

export const $ = (id) => document.getElementById(id);

// The only sanitiser in the front end. Every value that comes from the server
// and is written through innerHTML must pass through here — usernames,
// referral codes, event names and admin-entered rejection reasons are all
// attacker-influenced text.
//
// Numbers are the documented exception: call sites wrap those in Number(...),
// which cannot produce markup.
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
})[character]);

// Writes a message into one of the `<p class="notice" role="status">` elements
// that sit under each form.
export function showResult(element, message, isError = false) {
  element.textContent = message;
  element.className = `notice${isError ? ' error' : ''}`;
  element.hidden = false;
}

// Disables a button and swaps its label while a request is in flight, then
// puts the original label back.
//
// `label` is optional: assigning undefined to textContent stringifies it, so a
// caller that omitted one would leave the button reading "undefined".
export function setLoading(button, loading, label = 'Түр хүлээнэ үү…') {
  button.disabled = loading;
  if (loading) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else {
    button.textContent = button.dataset.label || button.textContent;
  }
}

/* ============================================================
   List states

   A list that fetches can be in one of four states, and for most of this
   site's life it rendered three of them as the same grey sentence: "Ачаалж
   байна…", "…алга" and "…ачаалж чадсангүй" differed only in wording, sat in
   the same faint grey, and none of the three offered a way forward. A buyer
   who could not tell a genuinely empty gift-card list from a request that
   had failed had no reason to reload, and no button to do it with.

   The three renderers below are the whole vocabulary. Every list on the
   storefront now uses them, so the states stay consistent between features
   that are otherwise unrelated.
   ============================================================ */

/**
 * Grey pulsing placeholders roughly the shape of the rows that are coming.
 * Sized to the real content so the list does not jump when it arrives.
 *
 * @param {HTMLElement} element
 * @param {{rows?: number, variant?: 'row'|'tile'}} [options]
 */
export function renderLoading(element, { rows = 3, variant = 'row' } = {}) {
  if (!element) return;
  const shape = variant === 'tile' ? 'skeleton-tile' : 'skeleton-row';
  element.innerHTML = `
    <div class="skeleton-list" aria-hidden="true">
      ${Array.from({ length: rows }, () => `<div class="skeleton ${shape}"></div>`).join('')}
    </div>
    <span class="sr-only" role="status">Ачаалж байна…</span>`;
}

/**
 * Nothing to show, and that is the correct answer. Takes an optional action
 * so an empty list can point at the thing that would fill it.
 *
 * @param {HTMLElement} element
 * @param {{icon?: string, title: string, body?: string,
 *          action?: {label: string, onClick: () => void}, inline?: boolean}} options
 */
export function renderEmpty(element, { icon = '◇', title, body = '', action, inline = false } = {}) {
  if (!element) return;
  element.innerHTML = `
    <div class="state${inline ? ' state-inline' : ''}">
      <span class="state-icon" aria-hidden="true">${escapeHtml(icon)}</span>
      <span class="state-title">${escapeHtml(title)}</span>
      ${body ? `<p class="state-body">${escapeHtml(body)}</p>` : ''}
      ${action ? '<button class="btn btn-ghost btn-sm" type="button" data-state-action></button>' : ''}
    </div>`;
  bindAction(element, action);
}

/**
 * The request failed. Deliberately *not* dressed as an empty list: it is a
 * different fact about the world, and unlike an empty list it is worth
 * pressing a button about.
 *
 * @param {HTMLElement} element
 * @param {{title?: string, body?: string, retry?: () => void, inline?: boolean}} options
 */
export function renderError(element, {
  title = 'Ачаалж чадсангүй',
  body = 'Холболтоо шалгаад дахин оролдоно уу.',
  retry,
  inline = false
} = {}) {
  if (!element) return;
  element.innerHTML = `
    <div class="state state-error${inline ? ' state-inline' : ''}" role="alert">
      <span class="state-icon" aria-hidden="true">!</span>
      <span class="state-title">${escapeHtml(title)}</span>
      ${body ? `<p class="state-body">${escapeHtml(body)}</p>` : ''}
      ${retry ? '<button class="btn btn-ghost btn-sm" type="button" data-state-action></button>' : ''}
    </div>`;
  bindAction(element, retry && { label: 'Дахин оролдох', onClick: retry });
}

// The button inside a state is wired directly rather than through a delegated
// click handler: these renderers are called from a dozen places and the
// callback is different every time, so the handler belongs with the node.
function bindAction(element, action) {
  if (!action) return;
  const button = element.querySelector('[data-state-action]');
  if (!button) return;
  button.textContent = action.label;
  button.addEventListener('click', action.onClick);
}
