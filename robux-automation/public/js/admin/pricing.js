// What the storefront quotes: the Robux rate, and the bank accounts customers
// transfer into.

import { $, escapeHtml, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt } from '../common/format.js';
import { confirmDialog } from './dialog.js';

function updatePricePreview(value) {
  const formatted = formatMnt(Number(value) || 0);
  $('price-preview').textContent = formatted;
  $('rate-stat').textContent = formatted;
}

export async function loadPricing() {
  try {
    const data = await request('/pricing', undefined, 'Үнийн мэдээлэл авч чадсангүй.');
    $('price-per-100').value = data.pricePer100;
    updatePricePreview(data.pricePer100);
  } catch (error) {
    showResult($('price-result'), error.message, true);
  }
}

// Several accounts, so a buyer can transfer inside their own bank. The list
// order is what buyers see, hence the up/down controls.
function renderBankAccounts(accounts) {
  if (!accounts.length) {
    $('bank-accounts-list').innerHTML =
      '<p class="hint">Данс нэмээгүй байна. Данс нэмэх хүртэл захиалагч төлбөрөө хийж чадахгүй.</p>';
    return;
  }

  $('bank-accounts-list').innerHTML = accounts.map((account, index) => `
    <div class="editable-row">
      <div>
        <strong>${escapeHtml(account.bankName)}</strong>
        <small>${escapeHtml(account.accountNumber)} · ${escapeHtml(account.accountHolder)}${
          account.isActive ? '' : ' · Идэвхгүй'}</small>
      </div>
      <div class="action-buttons">
        <button class="btn btn-sm" type="button" data-move-bank="${Number(account.id)}" data-direction="-1"
                ${index === 0 ? 'disabled' : ''} aria-label="Дээш">↑</button>
        <button class="btn btn-sm" type="button" data-move-bank="${Number(account.id)}" data-direction="1"
                ${index === accounts.length - 1 ? 'disabled' : ''} aria-label="Доош">↓</button>
        <button class="btn btn-sm" type="button" data-toggle-bank="${Number(account.id)}">${
          account.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}</button>
        <button class="btn btn-danger btn-sm" type="button" data-remove-bank="${Number(account.id)}">Устгах</button>
      </div>
    </div>`).join('');
}

// Held here so the reorder and toggle handlers can work from the current list
// without a round trip just to read what they already displayed.
let currentBankAccounts = [];

export async function loadBankAccount() {
  try {
    const data = await request('/admin/bank-accounts', undefined, 'Дансны мэдээлэл авч чадсангүй.');
    currentBankAccounts = data.accounts;
    renderBankAccounts(currentBankAccounts);
  } catch (error) {
    showResult($('bank-result'), error.message, true);
  }
}

// Deactivating rather than deleting is the safer default and the one an admin
// usually wants — a closed account should stop being offered without erasing
// the record of what customers were told to pay into last month.
async function toggleBankAccount(id) {
  const account = currentBankAccounts.find((entry) => entry.id === id);
  if (!account) return;

  try {
    await request(`/admin/bank-accounts/${id}`, jsonBody('PUT', {
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      accountHolder: account.accountHolder,
      isActive: !account.isActive
    }), 'Дансны төлөв өөрчилж чадсангүй.');
    showResult($('bank-result'), account.isActive ? 'Данс идэвхгүй боллоо.' : 'Данс идэвхжлээ.');
    await loadBankAccount();
  } catch (error) {
    showResult($('bank-result'), error.message, true);
  }
}

async function moveBankAccount(id, direction) {
  const index = currentBankAccounts.findIndex((entry) => entry.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= currentBankAccounts.length) return;

  const order = currentBankAccounts.map((entry) => entry.id);
  [order[index], order[target]] = [order[target], order[index]];

  try {
    await request('/admin/bank-accounts/order', jsonBody('PUT', { order }), 'Дарааллыг хадгалж чадсангүй.');
    await loadBankAccount();
  } catch (error) {
    showResult($('bank-result'), error.message, true);
  }
}

function initBankAccounts() {
  $('add-bank-btn').addEventListener('click', async () => {
    const button = $('add-bank-btn');
    setLoading(button, true, 'Нэмж байна…');
    try {
      await request('/admin/bank-accounts', jsonBody('POST', {
        bankName: $('bank-name-input').value.trim(),
        accountNumber: $('bank-account-input').value.trim(),
        accountHolder: $('bank-holder-input').value.trim()
      }), 'Данс нэмж чадсангүй.');

      $('bank-name-input').value = '';
      $('bank-account-input').value = '';
      $('bank-holder-input').value = '';
      showResult($('bank-result'), 'Данс нэмэгдлээ.');
      await loadBankAccount();
    } catch (error) {
      showResult($('bank-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('bank-accounts-list').addEventListener('click', async (event) => {
    const move = event.target.closest('[data-move-bank]');
    if (move) {
      return moveBankAccount(Number(move.dataset.moveBank), Number(move.dataset.direction));
    }

    const toggle = event.target.closest('[data-toggle-bank]');
    if (toggle) {
      return toggleBankAccount(Number(toggle.dataset.toggleBank));
    }

    const remove = event.target.closest('[data-remove-bank]');
    if (!remove) return;

    const confirmed = await confirmDialog(
      'Данс устгах',
      'Энэ данс жагсаалтаас бүрмөсөн хасагдана. Түр хаах бол оронд нь "Идэвхгүй болгох"-ыг сонгоно уу.',
      { confirmLabel: 'Устгах', danger: true }
    );
    if (!confirmed) return;

    try {
      await request(`/admin/bank-accounts/${remove.dataset.removeBank}`, { method: 'DELETE' }, 'Данс устгаж чадсангүй.');
      showResult($('bank-result'), 'Данс устгагдлаа.');
      await loadBankAccount();
    } catch (error) {
      showResult($('bank-result'), error.message, true);
    }
  });
}

export function initPricing() {
  $('price-per-100').addEventListener('input', (event) => updatePricePreview(event.target.value));

  $('price-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setLoading(button, true, 'Хадгалж байна…');
    try {
      const data = await request(
        '/admin/pricing',
        jsonBody('PUT', { pricePer100: Number($('price-per-100').value) }),
        'Үнэ бүхэл төгрөгөөр 100₮-өөс дээш байна.'
      );
      $('price-per-100').value = data.pricePer100;
      updatePricePreview(data.pricePer100);
      showResult($('price-result'), 'Үнэ хадгалагдлаа. Дэлгүүр шинэчлэгдсэн.');
    } catch (error) {
      showResult($('price-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  initBankAccounts();
}
