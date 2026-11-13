// The hand-off to our Messenger page for a manually delivered order.
//
// Neither automatic route can reach most buyers (see
// src/services/manual-route.js), so the order is created here and finished by
// a person in chat. What makes that workable is the first message: it carries
// the order's reference code, so the admin reading the chat can find the
// order in the queue without asking a single question.
//
// The text is put on the link as `?text=` so Messenger can prefill it, and is
// also copied to the clipboard on every press — not every Messenger client
// honours the prefill, and a buyer who lands in an empty chat can paste.

import { formatMnt, formatNumber } from '../common/format.js';
import { state } from './state.js';

export function messengerText({ reference, robux, amountMnt }) {
  return [
    'Сайн байна уу! Robux захиалга өгсөн.',
    `Захиалгын код: ${reference}`,
    state.username ? `Roblox: ${state.username}` : null,
    robux ? `Багц: ${formatNumber(robux)} Robux` : null,
    amountMnt ? `Дүн: ${formatMnt(amountMnt)}` : null
  ].filter(Boolean).join('\n');
}

export function messengerLink(baseUrl, order) {
  if (!baseUrl || !order.reference) return null;
  return `${baseUrl}?text=${encodeURIComponent(messengerText(order))}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* No clipboard permission. The prefill is still on the link. */
  }
}

/**
 * Opens a tab synchronously, while the click that asked for it is still a
 * user gesture. The order request that follows is async, and a window.open
 * after an await is exactly what popup blockers refuse — so the tab is taken
 * now and pointed at Messenger once there is a code to send.
 *
 * @returns {{ go(url: string, text: string): void, cancel(): void }}
 */
export function reserveMessengerTab() {
  const tab = window.open('about:blank', '_blank');
  return {
    go(url, text) {
      copyText(text);
      if (tab && !tab.closed) {
        tab.opener = null;
        tab.location.href = url;
      }
    },
    cancel() {
      if (tab && !tab.closed) tab.close();
    }
  };
}

/**
 * Shows the Messenger button in the payment panel, or hides it when the order
 * is not a manual one. The button is the dependable path: the automatic tab
 * can still be blocked, and a buyer who closed it needs a way back.
 */
export function renderMessengerHandoff(order) {
  const box = document.getElementById('messenger-handoff');
  const link = document.getElementById('messenger-link');
  if (!box || !link) return;

  const url = order.deliveryMethod === 'manual'
    ? messengerLink(order.messengerUrl || state.messengerUrl, order)
    : null;

  box.hidden = !url;
  if (!url) return;

  link.href = url;
  link.onclick = () => copyText(messengerText(order));
}
