// ══════════════════════════════════════════════════════════════
//  /api/billing — Stripe subscriptions (Stage 6). Consultant-only, except the
//  webhook (called by Stripe, verified by signature). Mounted in server.js:
//    - the webhook is registered on the RAW body BEFORE express.json
//    - the rest of the router is mounted at /api/billing after auth
//
//    GET  /api/billing/config                 { configured, hasPrice }
//    GET  /api/billing/status/:tenantId       tenant billing snapshot
//    POST /api/billing/checkout {tenantId}     -> { url } Checkout Session
//    POST /api/billing/portal   {tenantId}     -> { url } Billing Portal
//    POST /api/billing/webhook                 (raw body; Stripe events)
//
//  The webhook keeps tenants.subscription_status + tenants.status in step, so a
//  lapsed subscription auto-suspends access (dovetails with requireLiveStatus).
// ══════════════════════════════════════════════════════════════
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireConsultant } = require('../middleware/auth');
const B = require('../lib/billing');

const router = express.Router();

// Apply a Stripe subscription snapshot to a tenant. Central so the webhook and
// any manual sync behave identically. access=false -> suspend, true -> active
// (only flips status for billing reasons; a manually-suspended tenant with an
// active sub is reactivated, which is the intended "paid = on" behaviour).
async function applySubscription(tenantId, { customerId, subStatus, plan, periodEndIso }){
  const access = B.accessFromSubStatus(subStatus);
  await pool.query(
    `UPDATE tenants
        SET stripe_customer_id = COALESCE($2, stripe_customer_id),
            subscription_status = $3,
            plan = COALESCE($4, plan),
            current_period_end = $5,
            status = $6
      WHERE id = $1`,
    [tenantId, customerId || null, subStatus || 'none', plan || null, periodEndIso || null, access ? 'active' : 'suspended']
  );
}

// Resolve a tenant from a Stripe customer id (webhook events carry the customer,
// not our tenant id). We also stash tenantId in subscription metadata at
// checkout, so prefer that when present.
async function tenantIdForEvent(obj){
  if(obj?.metadata?.tenantId) return obj.metadata.tenantId;
  const customer = obj?.customer;
  if(customer){
    const r = await pool.query(`SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1`, [customer]);
    if(r.rows.length) return r.rows[0].id;
  }
  return null;
}

// ── Webhook (exported; mounted on the raw body in server.js) ────
async function webhookHandler(req, res){
  if(!B.isConfigured()) return res.status(503).json({ error: 'billing_not_configured' });
  const secret = B.webhookSecret();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    if(secret){
      event = B.stripe().webhooks.constructEvent(req.body, sig, secret);   // req.body is a Buffer (raw)
    } else {
      event = JSON.parse(req.body.toString('utf8'));                        // no secret set: accept unverified (dev only)
    }
  } catch(err){
    console.error('Stripe webhook signature check failed:', err.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }
  try {
    const o = event.data?.object || {};
    if(event.type === 'checkout.session.completed'){
      // Subscription now exists; pull it to get status + period end.
      const tenantId = o.metadata?.tenantId || await tenantIdForEvent(o);
      if(tenantId && o.subscription){
        const sub = await B.stripe().subscriptions.retrieve(o.subscription);
        await applySubscription(tenantId, {
          customerId: o.customer, subStatus: sub.status,
          plan: sub.items?.data?.[0]?.price?.id || null, periodEndIso: B.periodEndIso(sub.current_period_end)
        });
      }
    } else if(event.type.startsWith('customer.subscription.')){
      const tenantId = await tenantIdForEvent(o);
      if(tenantId){
        const subStatus = event.type === 'customer.subscription.deleted' ? 'canceled' : o.status;
        await applySubscription(tenantId, {
          customerId: o.customer, subStatus,
          plan: o.items?.data?.[0]?.price?.id || null, periodEndIso: B.periodEndIso(o.current_period_end)
        });
      }
    } else if(event.type === 'invoice.payment_failed'){
      const tenantId = await tenantIdForEvent(o);
      if(tenantId) await applySubscription(tenantId, { customerId: o.customer, subStatus: 'past_due', plan: null, periodEndIso: null });
    }
    res.json({ received: true });
  } catch(err){
    console.error('Stripe webhook handling error:', err.message);
    res.status(500).json({ error: 'webhook_error' });
  }
}

// ── Consultant endpoints ────────────────────────────────────────
router.get('/config', requireAuth, requireConsultant, (req, res) => {
  res.json({ configured: B.isConfigured(), hasPrice: B.hasPrice() });
});

router.get('/status/:tenantId', requireAuth, requireConsultant, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, status, subscription_status, plan, current_period_end, stripe_customer_id
         FROM tenants WHERE id = $1 LIMIT 1`, [req.params.tenantId]);
    if(!r.rows.length) return res.status(404).json({ error: 'tenant_not_found' });
    res.json({ tenant: r.rows[0] });
  } catch(err){ console.error('GET billing status error:', err); res.status(500).json({ error: 'server_error' }); }
});

router.post('/checkout', requireAuth, requireConsultant, async (req, res) => {
  if(!B.isConfigured()) return res.status(503).json({ error: 'billing_not_configured' });
  if(!B.hasPrice())     return res.status(503).json({ error: 'price_not_configured' });
  const tenantId = String(req.body?.tenantId || '').trim();
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  try {
    const tr = await pool.query(`SELECT id, name, stripe_customer_id FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
    if(!tr.rows.length) return res.status(404).json({ error: 'tenant_not_found' });
    const t = tr.rows[0];
    const stripe = B.stripe();
    let customerId = t.stripe_customer_id;
    if(!customerId){
      const c = await stripe.customers.create({ name: t.name, metadata: { tenantId } });
      customerId = c.id;
      await pool.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, tenantId]);
    }
    const base = (req.headers.origin || process.env.APP_ORIGIN || 'https://insight.archerhs.co.uk').replace(/\/$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: B.priceId(), quantity: 1 }],
      subscription_data: { metadata: { tenantId } },
      metadata: { tenantId },
      success_url: (process.env.BILLING_SUCCESS_URL || (base + '/?billing=success')),
      cancel_url:  (process.env.BILLING_CANCEL_URL  || (base + '/?billing=cancel')),
    });
    res.json({ url: session.url });
  } catch(err){ console.error('checkout error:', err.message); res.status(502).json({ error: 'stripe_error', detail: err.message }); }
});

router.post('/portal', requireAuth, requireConsultant, async (req, res) => {
  if(!B.isConfigured()) return res.status(503).json({ error: 'billing_not_configured' });
  const tenantId = String(req.body?.tenantId || '').trim();
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  try {
    const tr = await pool.query(`SELECT stripe_customer_id FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
    if(!tr.rows.length) return res.status(404).json({ error: 'tenant_not_found' });
    if(!tr.rows[0].stripe_customer_id) return res.status(400).json({ error: 'no_customer' });
    const base = (req.headers.origin || process.env.APP_ORIGIN || 'https://insight.archerhs.co.uk').replace(/\/$/, '');
    const session = await B.stripe().billingPortal.sessions.create({
      customer: tr.rows[0].stripe_customer_id,
      return_url: base + '/',
    });
    res.json({ url: session.url });
  } catch(err){ console.error('portal error:', err.message); res.status(502).json({ error: 'stripe_error', detail: err.message }); }
});

module.exports = { router, webhookHandler, applySubscription };
