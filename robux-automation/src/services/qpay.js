const axios = require('axios');

// QPay v2 adapter.
//
// The one thing worth understanding here: a payment callback is an untrusted
// HTTP request from the open internet. Anyone can POST to the callback URL,
// and the URL will end up in logs and browser history like any other. So the
// callback body is treated purely as a *hint that something happened* — the
// only value read from it is an opaque payment id, which is then used to ask
// QPay directly what that payment actually was.
//
// That server-to-server check is what makes a forged callback worthless: an
// attacker can make us look up a payment id, but they cannot make QPay say it
// was for 500,000₮ against someone else's reference.
//
// Swapping providers means reimplementing verifyPayment() to return the same
// { paid, reference, amountMnt, providerPaymentId } shape. Nothing outside
// this file knows what QPay is.

const BASE_URL = process.env.QPAY_BASE_URL || 'https://merchant.qpay.mn/v2';
const TIMEOUT_MS = 15000;

function config() {
  return {
    username: process.env.QPAY_USERNAME || '',
    password: process.env.QPAY_PASSWORD || '',
    invoiceCode: process.env.QPAY_INVOICE_CODE || ''
  };
}

function isConfigured() {
  const { username, password, invoiceCode } = config();
  return Boolean(username && password && invoiceCode);
}

function notConfigured() {
  return Object.assign(
    new Error('QPay тохируулагдаагүй байна.'),
    { code: 'QPAY_NOT_CONFIGURED' }
  );
}

// Access tokens are short-lived, so one is cached and refreshed a minute
// before expiry rather than minted per request.
let cachedToken = null;

async function getAccessToken({ forceRefresh = false } = {}) {
  if (!isConfigured()) throw notConfigured();

  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.token;
  }

  const { username, password } = config();
  const response = await axios.post(`${BASE_URL}/auth/token`, {}, {
    auth: { username, password },
    timeout: TIMEOUT_MS
  });

  const token = response.data?.access_token;
  if (!token) throw new Error('QPay access token авч чадсангүй.');

  // expires_in is seconds; fall back to 50 minutes if it's missing.
  const ttlMs = Number(response.data?.expires_in) * 1000;
  cachedToken = {
    token,
    expiresAt: Date.now() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 50 * 60 * 1000)
  };
  return token;
}

// Retries once on 401, since the cached token can expire between the check
// above and the request landing.
async function authorized(request) {
  let token = await getAccessToken();
  try {
    return await request(token);
  } catch (error) {
    if (error.response?.status !== 401) throw error;
    token = await getAccessToken({ forceRefresh: true });
    return request(token);
  }
}

// Creates the invoice a customer scans. `reference` is the order's own
// RBX-XXXXXX code and is echoed back to us on the callback, which is what
// ties the payment to the order.
async function createInvoice({ reference, amountMnt, description, callbackUrl }) {
  if (!isConfigured()) throw notConfigured();

  const { invoiceCode } = config();
  const response = await authorized((token) => axios.post(
    `${BASE_URL}/invoice`,
    {
      invoice_code: invoiceCode,
      sender_invoice_no: reference,
      invoice_receiver_code: reference,
      invoice_description: description || `rbxmn ${reference}`,
      amount: Math.round(Number(amountMnt)),
      callback_url: `${callbackUrl}?reference=${encodeURIComponent(reference)}`
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS }
  ));

  return {
    invoiceId: response.data?.invoice_id,
    qrText: response.data?.qr_text || null,
    qrImage: response.data?.qr_image || null,
    // Deep links into each Mongolian banking app.
    urls: Array.isArray(response.data?.urls) ? response.data.urls : []
  };
}

// Asks QPay what actually happened. This is the authoritative read — the
// callback that triggered it is not trusted for anything but the id.
//
// Returns null when the payment can't be confirmed, which the caller must
// treat as "do not credit" rather than "assume paid".
async function verifyPayment(invoiceId) {
  if (!isConfigured()) throw notConfigured();

  const response = await authorized((token) => axios.post(
    `${BASE_URL}/payment/check`,
    { object_type: 'INVOICE', object_id: invoiceId, offset: { page_number: 1, page_count: 100 } },
    { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS }
  ));

  const rows = Array.isArray(response.data?.rows) ? response.data.rows : [];
  const settled = rows.filter((row) => String(row.payment_status).toUpperCase() === 'PAID');
  if (!settled.length) return null;

  // QPay permits split payments against one invoice, so the credited amount
  // is the sum of settled rows rather than the first one.
  const amountMnt = settled.reduce((total, row) => total + Number(row.payment_amount || 0), 0);

  return {
    paid: true,
    providerPaymentId: String(settled[0].payment_id),
    amountMnt,
    // sender_invoice_no is the reference we set at creation; it is echoed
    // back by QPay rather than supplied by the payer.
    reference: response.data?.sender_invoice_no || settled[0].sender_invoice_no || null,
    rowCount: settled.length
  };
}

module.exports = { isConfigured, createInvoice, verifyPayment, getAccessToken };
