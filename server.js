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
  RZP_WEBHOOK_SECRET, // the secret you set when creating the webhook in Razorpay
  CARECOMPASS_VERIFY_TOKEN, // optional bearer token to protect GET /api/status
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

// In-memory payment store so a third-party site (e.g. astromatch) can verify a
// payment by its `ref`. NOTE: resets on restart and is NOT multi-instance safe —
// use a DB/Redis in production. Keyed by Razorpay order id, indexed by ref.
const ordersById = new Map();   // order_id -> record
const orderIdByRef = new Map(); // ref      -> order_id (latest)
function recordOrder(rec) {
  ordersById.set(rec.order_id, rec);
  if (rec.ref) orderIdByRef.set(rec.ref, rec.order_id);
}
function markPaid(order_id, payment_id) {
  const rec = ordersById.get(order_id);
  if (rec) { rec.paid = true; rec.status = 'paid'; rec.payment_id = payment_id || rec.payment_id; }
  return rec;
}

const app = express();

/* ---------------------------------------------------------------------------
 * Razorpay webhook — the AUTHORITATIVE, reliable confirmation (the browser
 * callback can be lost if the buyer closes the tab). Must be registered BEFORE
 * express.json() because signature verification needs the RAW request body.
 * Set RZP_WEBHOOK_SECRET to the secret you choose when creating the webhook in
 * Razorpay Dashboard → Settings → Webhooks (events: payment.captured, order.paid).
 * ------------------------------------------------------------------------- */
const handledEvents = new Set(); // idempotency — use a DB/Redis in production
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  if (!RZP_WEBHOOK_SECRET) return res.status(503).send('webhook secret not configured');

  const signature = req.headers['x-razorpay-signature'] || '';
  const expected = crypto.createHmac('sha256', RZP_WEBHOOK_SECRET).update(req.body).digest('hex');
  const valid = signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(400).send('invalid signature');

  const event = JSON.parse(req.body.toString('utf8'));
  const eventId = req.headers['x-razorpay-event-id'];
  if (eventId && handledEvents.has(eventId)) return res.json({ ok: true, deduped: true });
  if (eventId) handledEvents.add(eventId);

  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    const p = event.payload?.payment?.entity;
    // ✅ Authoritative fulfilment — mark the order paid so /api/status reports it.
    if (p?.order_id) markPaid(p.order_id, p.id);
    console.log(`✅ ${event.event}: payment ${p?.id}, order ${p?.order_id}, ${p?.amount} ${p?.currency}`);
  }
  res.json({ ok: true });
});

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
app.post('/create-order', async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay keys not configured on the server' });
  }
  // A third-party site (astromatch) can pass these so the payment can be looked up later.
  const ref = String(req.body?.ref || '');
  const product = String(req.body?.product || '');
  const client_reference_id = String(req.body?.client_reference_id || '');
  try {
    const order = await razorpay.orders.create({
      amount: Number(AMOUNT),
      currency: CURRENCY,
      receipt: `cc_${Date.now()}`,
      notes: { ref, product, client_reference_id },
    });
    recordOrder({ order_id: order.id, ref, product, client_reference_id, amount: order.amount, currency: order.currency, paid: false, status: 'created', payment_id: null });
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
  if (verified) markPaid(razorpay_order_id, razorpay_payment_id); // immediate; webhook re-confirms
  res.status(verified ? 200 : 400).json({ verified });
});

/* ---------------------------------------------------------------------------
 * Payment status by ref — a third-party site (astromatch) points its
 * CARECOMPASS_VERIFY_URL here and reads `paid` to grant entitlement.
 * Optional bearer auth: set CARECOMPASS_VERIFY_TOKEN and send it as
 * `Authorization: Bearer <token>` (or ?token=<token>).
 * ------------------------------------------------------------------------- */
app.get('/api/status', (req, res) => {
  if (CARECOMPASS_VERIFY_TOKEN) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (token !== CARECOMPASS_VERIFY_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  }
  const ref = String(req.query.ref || '');
  const orderId = orderIdByRef.get(ref);
  const rec = orderId ? ordersById.get(orderId) : null;
  if (!rec) return res.json({ found: false, paid: false, ref });
  res.json({
    found: true,
    paid: !!rec.paid,
    status: rec.status,
    ref: rec.ref,
    client_reference_id: rec.client_reference_id || null,
    product: rec.product || null,
    payment_id: rec.payment_id || null,
    order_id: rec.order_id,
    amount: rec.amount,
    currency: rec.currency,
  });
});

// Public pricing — single source of truth so the landing page and the actual
// charge can never drift apart (both read from AMOUNT).
app.get('/price', (_req, res) => res.json({ amount: Number(AMOUNT), currency: CURRENCY }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------------------------------------------------------------------------
 * 4) Serve the static frontend (the Apple Pay express-button page).
 * ------------------------------------------------------------------------- */
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`▶ CareCompass Apple Pay running on :${PORT}  (${CURRENCY} ${Number(AMOUNT) / 100})`);
});
