import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Razorpay from 'razorpay';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  RZP_KEY_ID,
  RZP_KEY_SECRET,
  PORT = 3000,
  CURRENCY = 'USD', // MUST be non-INR — INR hides Apple Pay
  AMOUNT = '200',   // smallest currency unit; 200 = $2.00
} = process.env;

const configured = Boolean(RZP_KEY_ID && RZP_KEY_SECRET);
if (!configured) {
  console.warn('⚠️  RZP_KEY_ID / RZP_KEY_SECRET not set — the server still boots, but /create-order returns 503 until you add them (.env or Railway Variables).');
}

// Built lazily so a missing key never crashes boot (the SDK throws on construction).
const razorpay = configured ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET }) : null;

const app = express();
app.use(express.json());

/* ---------------------------------------------------------------------------
 * 1) Apple Pay domain-association file
 *    Apple requires: HTTP 200, Content-Type: text/plain, and NO redirect.
 *    express.static ignores dot-folders by default, so we serve it explicitly.
 *    Replace ./.well-known/apple-developer-merchantid-domain-association with
 *    the real "Verification file" from the Razorpay Apple Pay dashboard.
 * ------------------------------------------------------------------------- */
app.get('/.well-known/apple-developer-merchantid-domain-association', (_req, res) => {
  try {
    const file = readFileSync(
      path.join(__dirname, '.well-known', 'apple-developer-merchantid-domain-association'),
      'utf8',
    );
    res.type('text/plain').status(200).send(file);
  } catch {
    res.status(404).send('domain-association file missing — add it under .well-known/');
  }
});

/* ---------------------------------------------------------------------------
 * 2) Create a USD order. The key_secret lives ONLY here, never in the browser.
 * ------------------------------------------------------------------------- */
app.post('/create-order', async (_req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay keys not configured on the server' });
  }
  try {
    const order = await razorpay.orders.create({
      amount: Number(AMOUNT),
      currency: CURRENCY,
      receipt: `cc_${Date.now()}`,
    });
    // Hand the public key_id to the client so it isn't hard-coded in the page.
    res.json({ id: order.id, amount: order.amount, currency: order.currency, key_id: RZP_KEY_ID });
  } catch (err) {
    console.error('create-order failed:', err?.error || err);
    res.status(500).json({ error: 'could not create order' });
  }
});

/* ---------------------------------------------------------------------------
 * 3) Verify the payment signature after Apple Pay succeeds.
 *    HMAC-SHA256 of "order_id|payment_id" with your key_secret.
 * ------------------------------------------------------------------------- */
app.post('/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!configured) {
    return res.status(503).json({ verified: false, error: 'Razorpay keys not configured on the server' });
  }
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: 'missing fields' });
  }
  const expected = crypto
    .createHmac('sha256', RZP_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  const verified = expected === razorpay_signature;
  res.status(verified ? 200 : 400).json({ verified });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------------------------------------------------------------------------
 * 4) Serve the static frontend (the Apple Pay express-button page).
 * ------------------------------------------------------------------------- */
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`▶ CareCompass Apple Pay running on :${PORT}  (${CURRENCY} ${Number(AMOUNT) / 100})`);
});
