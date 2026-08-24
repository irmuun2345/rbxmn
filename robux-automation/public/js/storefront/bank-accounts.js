// The bank accounts on the payment panel.
//
// Several are listed rather than one so a buyer can transfer inside their own
// bank, where the money lands immediately instead of overnight. They are not
// asked to choose: whichever they pay into, the order is found by its
// RBX-XXXXXX reference, so a "wrong" account does not exist.
//
// Shared by the order panel and the gift-card panel, which show the same list
// in two places on the same page — hence the id prefix.

import { escapeHtml } from '../common/dom.js';

// Server-supplied strings, all of them written by an admin and none of them
// escaped anywhere else on the way here.
function accountCard(account, idPrefix, index) {
  const numberId = `${idPrefix}-number-${index}`;
  const holderId = `${idPrefix}-holder-${index}`;

  return `
    <div class="bank-card">
      <p class="bank-card-name">${escapeHtml(account.name)}</p>
      <div class="copy-row">
        <span>Дансны дугаар</span>
        <strong id="${numberId}">${escapeHtml(account.accountNumber)}</strong>
        <button type="button" class="copy-btn" data-copy-target="${numberId}">Хуулах</button>
      </div>
      <div class="copy-row">
        <span>Хүлээн авагч</span>
        <strong id="${holderId}">${escapeHtml(account.accountHolder)}</strong>
        <button type="button" class="copy-btn" data-copy-target="${holderId}">Хуулах</button>
      </div>
    </div>`;
}

export function renderBankAccounts(container, accounts, idPrefix) {
  if (!container) return;

  // An order exists and is owed money, but there is nowhere to send it. Saying
  // so plainly beats three dashes the buyer would sit and wait on.
  if (!Array.isArray(accounts) || !accounts.length) {
    container.innerHTML = '<p class="hint">Данс тохируулаагүй байна. Тусламжтай холбогдоно уу.</p>';
    return;
  }

  container.innerHTML = accounts
    .map((account, index) => accountCard(account, idPrefix, index))
    .join('');
}
