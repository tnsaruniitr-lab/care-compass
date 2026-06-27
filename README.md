# CareCompass — Apple Pay express checkout

A minimal **Node/Express + Razorpay Custom Checkout** app that shows a **native Apple Pay
button directly on the page** (no contact/email form, no Razorpay modal). Built to deploy on
**Railway** and serve from `pay.carecompass.me`.

```
carecompass-applepay/
├── server.js                  # Express: order creation, signature verify, .well-known route
├── public/index.html          # the Apple Pay express-button page (razorpay.js Custom Checkout)
├── .well-known/
│   └── apple-developer-merchantid-domain-association   # ← REPLACE with Razorpay's real file
├── .env.example               # env template
├── railway.json               # Railway/Nixpacks deploy config
└── package.json
```

---

## How it works
1. The page asks the server for a **USD order** (`POST /create-order`). Non-INR is what reveals Apple Pay.
2. `razorpay.canMakePayment({ method:'card', app:{name:'apple_pay'} })` checks the device can do Apple Pay.
3. If yes, `razorpay.mount(...)` renders the **real Apple Pay button** on the page.
4. Tap → the **native Apple Pay sheet** opens (name/email/address from the Wallet) → Face ID → done.
5. `POST /verify-payment` checks the signature server-side before you fulfil.

The `key_secret` lives **only** on the server. Never put it in the browser.

---

## Prerequisites (on your Razorpay account)
- **International Payments** active, and **Apple Pay** enabled (you already have this ✅).
- **Custom Checkout** enabled (the `razorpay.js` / `mount` / `createPayment` API). If `canMakePayment`
  is undefined at runtime, ask Razorpay support to enable Custom Checkout.
- **LIVE** API keys — Apple Pay does **not** work in test mode.

---

## 1) Run locally (sanity check only)
```bash
npm install
cp .env.example .env        # add your LIVE RZP_KEY_ID / RZP_KEY_SECRET
npm run dev                 # http://localhost:3000
```
> On a non-Apple browser you'll see “Apple Pay isn’t available here” — that's correct. The button
> only renders in **Safari on an Apple device with a non-Indian card in Apple Wallet**.

## 2) Replace the domain-association file
Download the **Verification file** from the Razorpay Apple Pay tab and overwrite
`.well-known/apple-developer-merchantid-domain-association` with its exact contents.
`server.js` serves it at `/.well-known/...` with `Content-Type: text/plain`, HTTP 200, no redirect.

## 3) Push to GitHub → deploy on Railway
```bash
git init && git add -A && git commit -m "CareCompass Apple Pay sample"
# create a GitHub repo, then:
git remote add origin git@github.com:<you>/carecompass-applepay.git
git push -u origin main
```
- Railway → **New Project → Deploy from GitHub repo** → pick this repo (Nixpacks auto-detects `npm start`).
- Railway → **Variables**: `RZP_KEY_ID`, `RZP_KEY_SECRET`, `CURRENCY=USD`, `AMOUNT=1000`.
  (Don't set `PORT` — Railway injects it; the server already reads `process.env.PORT`.)

## 4) Point the subdomain at Railway
- Railway → service → **Settings → Public Networking → + Custom Domain** → add `pay.carecompass.me`.
  Railway shows you **TWO records**, both unique to your domain:
  - a **CNAME** → a `…up.railway.app` target, and
  - a **TXT** ownership-verification record.
- At your registrar, add **both**. ⚠️ With only the CNAME, the domain stays unverified and returns 404 — the TXT is required.
- HTTPS (Let's Encrypt) auto-provisions once DNS resolves — usually within an hour.
- **Apex note:** if you ever use the bare `carecompass.me` instead of a subdomain, Railway gives no fixed IP for an A record — you need CNAME-flattening/ALIAS (Cloudflare, DNSimple, Namecheap) or delegate nameservers to Cloudflare. This is why the subdomain is easier.

## 5) Verify the domain in Razorpay
Apple Pay tab → add/verify **`pay.carecompass.me`** → **Verify domains**. The `.well-known` route makes this pass.

### (Optional) Disconnect the old Replit domain
If you're moving `carecompass.me` (or a sub) off Replit: Replit → app → **Deployments → Settings → Unlink domain** (this does **not** delete the deployment — it reverts to the `*.replit.app` URL). Then delete the old **A record** and the **`replit-verify=…` TXT** record at your registrar so they don't conflict. (Using a *new* subdomain like `pay.` for Railway means you don't have to touch Replit at all.)

## 6) Test
Open **`https://pay.carecompass.me`** in **Safari** on a Mac/iPhone with a **non-Indian card** in Apple Wallet → tap the Apple Pay button.

---

## The 4 hard rules (Apple Pay won't appear otherwise)
1. **Live** key (`rzp_live_…`) — never test mode.
2. Order currency is **non-INR** (USD here).
3. Page on **HTTPS**, on a **verified domain**.
4. **Safari + Apple device + non-Indian card** in Wallet.

## Webhook — reliable fulfillment (recommended)
The browser `payment.success` callback can be lost (user closes the tab). The **authoritative** confirmation is a webhook:
1. Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**.
2. **URL** `https://pay.carecompass.me/webhook` · choose a **Secret** · **Events**: `payment.captured`, `order.paid`.
3. Set that same secret as the Railway Variable **`RZP_WEBHOOK_SECRET`**.

The `/webhook` route verifies the `X-Razorpay-Signature` (HMAC-SHA256 of the **raw** body), de-dupes by `X-Razorpay-Event-Id`, and is where you should **fulfil the order** (grant access / email the plan) — not the browser callback. The client `/verify-payment` stays only for instant on-screen confirmation.

## Pricing — single source of truth
The displayed price comes from `GET /price` (which reads `AMOUNT`), so the landing page and the actual charge can never drift. Change the price in **one** place: the `AMOUNT` env var (smallest unit — $2 = `200`, $49 = `4900`).

## Notes
- This uses the **`mount()`** approach (Razorpay renders the Apple-styled button). The alternative is to
  render your own button and call **`razorpay.createPayment({ order_id, method:'card', app:{name:'apple_pay'} })`**
  on click — see Razorpay's *Apple Pay → Custom Integration* docs.
- Confirm the exact Custom Checkout method surface against the live Razorpay docs; the API names here
  (`canMakePayment`, `mount`, `on('payment.success')`) follow Razorpay's Custom Integration guide.
