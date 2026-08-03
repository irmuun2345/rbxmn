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
