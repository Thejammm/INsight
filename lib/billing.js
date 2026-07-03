// ══════════════════════════════════════════════════════════════
//  Billing helper (Stage 6 — Stripe). Central place that knows whether Stripe
//  is configured and, if so, hands out a single Stripe client. Everything is
//  driven by environment variables so no keys live in source:
//    STRIPE_SECRET_KEY       — sk_live_... / sk_test_...   (enables billing)
//    STRIPE_WEBHOOK_SECRET   — whsec_...                   (verifies webhooks)
//    STRIPE_PRICE_ID         — price_...                   (the subscription price)
//    BILLING_SUCCESS_URL     — where Checkout returns on success (optional)
//    BILLING_CANCEL_URL      — where Checkout returns on cancel  (optional)
//
//  If STRIPE_SECRET_KEY is unset the whole feature no-ops: isConfigured() is
//  false and the routes return `billing_not_configured` (503) instead of
//  crashing. This lets the app ship and run before any keys exist.
// ══════════════════════════════════════════════════════════════
let _client = null;

function isConfigured(){ return !!process.env.STRIPE_SECRET_KEY; }
function hasPrice(){ return !!process.env.STRIPE_PRICE_ID; }
function webhookSecret(){ return process.env.STRIPE_WEBHOOK_SECRET || null; }
function priceId(){ return process.env.STRIPE_PRICE_ID || null; }

// Lazily build (and cache) the Stripe client. Returns null when unconfigured.
function stripe(){
  if(!isConfigured()) return null;
  if(!_client){
    const Stripe = require('stripe');
    _client = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return _client;
}

// Map a Stripe subscription status to whether the tenant should have access.
// Active + trialing + past_due keep access (past_due = a grace period while
// Stripe retries the card). canceled / unpaid / incomplete_expired lose it.
function accessFromSubStatus(subStatus){
  return ['active', 'trialing', 'past_due'].includes(subStatus);
}

// A period-end value (unix seconds) → ISO string for Postgres, or null.
function periodEndIso(unixSeconds){
  if(!unixSeconds && unixSeconds !== 0) return null;
  try { return new Date(unixSeconds * 1000).toISOString(); } catch(e){ return null; }
}

module.exports = { isConfigured, hasPrice, webhookSecret, priceId, stripe, accessFromSubStatus, periodEndIso };
