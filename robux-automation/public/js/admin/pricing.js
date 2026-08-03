// The two numbers the storefront quotes: the Robux rate, and the bank
// account customers transfer to.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';
import { formatMnt } from '../common/format.js';

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

export async function loadBankAccount() {
  try {
    const data = await request('/bank-account', undefined, 'Дансны мэдээлэл авч чадсангүй.');
    $('bank-name-input').value = data.bankName;
    $('bank-account-input').value = data.accountNumber;
    $('bank-holder-input').value = data.accountHolder;
  } catch (error) {
    showResult($('bank-result'), error.message, true);
  }
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

  $('bank-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setLoading(button, true, 'Хадгалж байна…');
    try {
      await request('/admin/bank-account', jsonBody('PUT', {
        bankName: $('bank-name-input').value.trim(),
        accountNumber: $('bank-account-input').value.trim(),
        accountHolder: $('bank-holder-input').value.trim()
      }), 'Дансны мэдээлэл шинэчлэгдсэнгүй.');
      showResult($('bank-result'), 'Дансны мэдээлэл хадгалагдлаа.');
    } catch (error) {
      showResult($('bank-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });
}
