// The modal that replaces window.prompt / window.confirm.
//
// The native pair rendered unstyled OS chrome, could not validate or explain
// anything, and blocked the whole page — including the order queue polling
// behind it. A bad value typed into window.prompt closed the dialog and lost
// the text, which on a payout screen is worse than an error message.
//
// <dialog> gives focus trapping, Esc-to-close and inertness for free.

import { $ } from '../common/dom.js';

/**
 * Resolves to the entered value, `true` for a plain confirmation, or null on
 * cancel — mirroring prompt/confirm so call sites read the same way.
 *
 * @param {object}   options
 * @param {string}   options.title
 * @param {string}   [options.message]
 * @param {object}   [options.input]        omit for a yes/no confirmation
 * @param {string}   [options.confirmLabel]
 * @param {boolean}  [options.danger]       red confirm button
 * @param {function} [options.validate]     returns an error string to keep
 *                                          the dialog open, or null to accept
 */
export function openDialog({ title, message, input = null, confirmLabel = 'Тийм', danger = false, validate }) {
  const dialog = $('app-dialog');
  const field = $('app-dialog-field');
  const control = $('app-dialog-input');
  const error = $('app-dialog-error');
  const confirmBtn = $('app-dialog-confirm');

  $('app-dialog-title').textContent = title;
  $('app-dialog-message').textContent = message || '';
  $('app-dialog-message').hidden = !message;
  error.hidden = true;
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

  field.hidden = !input;
  if (input) {
    $('app-dialog-label').textContent = input.label;
    $('app-dialog-hint').textContent = input.hint || '';
    $('app-dialog-hint').hidden = !input.hint;
    control.type = input.type || 'text';
    control.value = input.value ?? '';
    control.placeholder = input.placeholder || '';
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      // Esc fires `cancel` and then `close`, and the buttons call this
      // directly, so `done` can legitimately be reached more than once for a
      // single dialog. Resolving twice is harmless but clearing the listeners
      // twice is not worth reasoning about — latch instead.
      if (settled) return;
      settled = true;
      confirmBtn.removeEventListener('click', onConfirm);
      $('app-dialog-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onCancel);
      dialog.close();
      resolve(value);
    };

    function onConfirm() {
      const value = input ? control.value : true;
      const problem = validate ? validate(value) : null;
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        control.focus();
        return;
      }
      done(value);
    }
    function onCancel() { done(null); }

    confirmBtn.addEventListener('click', onConfirm);
    $('app-dialog-cancel').addEventListener('click', onCancel);
    // Esc dismisses a modal <dialog> without touching either button. It fires
    // `cancel` first and `close` after; both are wired so the promise still
    // settles if a browser only delivers one of them — an unsettled promise
    // here would leave the caller's button disabled forever with no visible
    // dialog to explain why.
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onCancel);

    dialog.showModal();
    (input ? control : confirmBtn).focus();
    if (input) control.select();
  });
}

export const confirmDialog = (title, message, { confirmLabel = 'Тийм', danger = false } = {}) =>
  openDialog({ title, message, confirmLabel, danger }).then(Boolean);

// Both the order queue and the gift-card queue ask for the same thing before
// refusing a payment: a reason the customer will read verbatim.
export function askRejectionReason({ title, message, placeholder }) {
  return openDialog({
    title,
    message,
    input: { label: 'Татгалзсан шалтгаан', placeholder },
    confirmLabel: 'Татгалзах',
    danger: true,
    validate: (value) => (value.trim().length < 4 ? 'Шалтгааныг тодорхой бичнэ үү.' : null)
  });
}

// The optional free-text note recorded alongside a manual resolution or a
// referral payout.
export function askNote(message, placeholder) {
  return openDialog({
    title: 'Тэмдэглэл',
    message,
    input: { label: 'Тэмдэглэл', placeholder },
    confirmLabel: 'Хадгалах'
  }).then((value) => value || '');
}
