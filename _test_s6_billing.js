// Local test for Stage 6 — Stripe billing. Covers the no-op-safe (unconfigured)
// path and the webhook -> tenant status sync with a *signed* test event (no real
// Stripe API calls). Run: node _test_s6_billing.js
process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-000';
delete process.env.STRIPE_SECRET_KEY;      // start unconfigured
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.STRIPE_PRICE_ID;

const fs = require('fs'), path = require('path'), http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { newDb } = require('pg-mem');

let pass = 0, fail = 0;
function ok(name, cond){ (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); }

(async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  schema.split(/;\s*(?:\r?\n|$)/).map(s => s.replace(/^\s*(?:--[^\n]*\n)+/gm, '').trim()).filter(Boolean)
    .forEach(s => { try { db.public.none(s); } catch(e){} });

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const dbPath = require.resolve('./db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };

  const { router: billingRouter, webhookHandler } = require('./routes/billing');
  const { signSession } = require('./middleware/auth');

  await pool.query(`INSERT INTO tenants (id,name,status,subscription_status) VALUES ('org-x','Vest Construction','active','none')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-cli','cli@vest','h','org-x','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    cli: signSession({ id:'u-cli', email:'cli@vest', role:'client_user', tenant_id:'org-x', display_name:'Vest' }),
  };

  const app = express(); app.use(cookieParser());
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);
  app.use(express.json());
  app.use('/api/billing', billingRouter);
  const server = app.listen(0); const port = server.address().port;
  function call(method, p, token, body, rawHeaders){
    return new Promise(resolve => {
      const data = body === undefined ? null : (Buffer.isBuffer(body) ? body : JSON.stringify(body));
      const headers = Object.assign({ 'Content-Type':'application/json' }, token ? { 'Cookie':'ahs_session='+token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, rawHeaders || {});
      const req = http.request({ host:'127.0.0.1', port, path:p, method, headers },
        res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ let j=null; try{ j=JSON.parse(d); }catch(e){} resolve({ status:res.statusCode, body:j }); }); });
      req.on('error', e => resolve({ status:0, error:e.message })); if(data) req.write(data); req.end();
    });
  }

  // ── Unconfigured: safe no-op ──
  let r = await call('GET', '/api/billing/config', tok.con);
  ok('config reports not configured', r.status === 200 && r.body.configured === false);
  r = await call('POST', '/api/billing/checkout', tok.con, { tenantId:'org-x' });
  ok('checkout is 503 billing_not_configured when no key', r.status === 503 && r.body.error === 'billing_not_configured');
  r = await call('GET', '/api/billing/config', tok.cli);
  ok('client cannot read billing config (403)', r.status === 403);
  r = await call('POST', '/api/billing/webhook', null, Buffer.from('{}'), { 'Content-Type':'application/json' });
  ok('webhook is 503 when unconfigured', r.status === 503);

  // ── Configure Stripe (test key + webhook secret; no real API calls made by
  //    the subscription.* events, which read the event object directly) ──
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_key_for_local_signature_only';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  function signedPost(eventObj){
    const payload = JSON.stringify(eventObj);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    return call('POST', '/api/billing/webhook', null, Buffer.from(payload), { 'Content-Type':'application/json', 'stripe-signature': header });
  }
  async function tenant(){ return (await pool.query(`SELECT status, subscription_status, plan FROM tenants WHERE id='org-x'`)).rows[0]; }

  r = await call('GET', '/api/billing/config', tok.con);
  ok('config reports configured after keys set', r.body.configured === true);

  // active subscription -> tenant active + subscribed
  r = await signedPost({ type:'customer.subscription.updated', data:{ object:{ customer:'cus_1', status:'active', metadata:{ tenantId:'org-x' }, items:{ data:[{ price:{ id:'price_123' } }] }, current_period_end: 1790000000 } } });
  ok('signed active-subscription webhook accepted (200)', r.status === 200 && r.body.received === true);
  let t = await tenant();
  ok('tenant marked subscribed + active', t.subscription_status === 'active' && t.status === 'active' && t.plan === 'price_123');

  // bad signature is rejected
  r = await call('POST', '/api/billing/webhook', null, Buffer.from(JSON.stringify({ type:'customer.subscription.updated', data:{ object:{} } })), { 'Content-Type':'application/json', 'stripe-signature': 't=1,v1=deadbeef' });
  ok('tampered/invalid signature rejected (400)', r.status === 400 && r.body.error === 'invalid_signature');

  // subscription deleted -> canceled -> tenant auto-suspended
  r = await signedPost({ type:'customer.subscription.deleted', data:{ object:{ customer:'cus_1', status:'canceled', metadata:{ tenantId:'org-x' } } } });
  ok('signed cancel webhook accepted', r.status === 200);
  t = await tenant();
  ok('cancelled subscription auto-suspends the tenant', t.subscription_status === 'canceled' && t.status === 'suspended');

  // payment failed -> past_due keeps access (grace period)
  r = await signedPost({ type:'invoice.payment_failed', data:{ object:{ customer:'cus_1', metadata:{ tenantId:'org-x' } } } });
  t = await tenant();
  ok('payment_failed -> past_due keeps access (grace)', t.subscription_status === 'past_due' && t.status === 'active');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
