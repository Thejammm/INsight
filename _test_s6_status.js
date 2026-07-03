// Local test for Stage 6 Item 1 — tenant suspension + live status enforcement.
// pg-mem, real JWTs, the real live-status guard + routers over HTTP.
// Run: node _test_s6_status.js
process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-000';

const fs = require('fs'), path = require('path'), http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
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

  const authRouter = require('./routes/auth');
  const adminRouter = require('./routes/admin');
  const { router: projectsRouter } = require('./routes/projects');
  const { signSession, requireLiveStatus } = require('./middleware/auth');

  const conHash = await bcrypt.hash('consultant123', 10);
  const cliHash = await bcrypt.hash('client12345', 10);
  await pool.query(`INSERT INTO tenants (id,name,status) VALUES ('org-x','Vest Construction','active')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role,display_name,is_active) VALUES
    ('u-con','con@ahs',$1,NULL,'consultant','AHS',TRUE),
    ('u-cli','cli@vest',$2,'org-x','client_user','Vest User',TRUE)`, [conHash, cliHash]);

  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    cli: signSession({ id:'u-cli', email:'cli@vest', role:'client_user', tenant_id:'org-x', display_name:'Vest User' }),
  };

  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api', (req, res, next) => { if(req.path.startsWith('/auth')) return next(); return requireLiveStatus(req, res, next); });
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/projects', projectsRouter);
  const server = app.listen(0); const port = server.address().port;
  function call(method, p, token, body){
    return new Promise(resolve => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host:'127.0.0.1', port, path:p, method, headers: Object.assign(
        { 'Content-Type':'application/json' }, token ? { 'Cookie':'ahs_session='+token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
        res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ let j=null; try{ j=JSON.parse(d); }catch(e){} resolve({ status:res.statusCode, body:j }); }); });
      req.on('error', e => resolve({ status:0, error:e.message })); if(data) req.write(data); req.end();
    });
  }

  // Baseline: active user + active tenant passes the guard.
  let r = await call('GET', '/api/projects', tok.cli);
  ok('active client reaches the API (200)', r.status === 200);
  r = await call('GET', '/api/projects', tok.con);
  ok('consultant reaches the API (200)', r.status === 200);

  // Admin can suspend the tenant.
  r = await call('PATCH', '/api/admin/tenants/org-x', tok.con, { status:'suspended' });
  ok('consultant suspends the tenant (200)', r.status === 200 && r.body.tenant.status === 'suspended');
  r = await call('PATCH', '/api/admin/tenants/org-x', tok.con, { status:'nonsense' });
  ok('invalid status rejected (400)', r.status === 400 && r.body.error === 'invalid_status');

  // Suspended tenant: the client is blocked live, even with a valid cookie.
  r = await call('GET', '/api/projects', tok.cli);
  ok('suspended tenant client is blocked (403 tenant_suspended)', r.status === 403 && r.body.error === 'tenant_suspended');
  // ...but the consultant (no tenant) is unaffected.
  r = await call('GET', '/api/projects', tok.con);
  ok('consultant unaffected by tenant suspension (200)', r.status === 200);
  // ...and login is refused too (no redirect loop).
  r = await call('POST', '/api/auth/login', null, { email:'cli@vest', password:'client12345' });
  ok('suspended tenant login refused (403 tenant_suspended)', r.status === 403 && r.body.error === 'tenant_suspended');

  // Reactivate -> access restored.
  r = await call('PATCH', '/api/admin/tenants/org-x', tok.con, { status:'active' });
  ok('consultant reactivates the tenant (200)', r.status === 200 && r.body.tenant.status === 'active');
  r = await call('GET', '/api/projects', tok.cli);
  ok('reactivated client reaches the API again (200)', r.status === 200);

  // Deactivate the user -> blocked live (401), independent of tenant status.
  await call('PATCH', '/api/admin/users/u-cli/active', tok.con, { active:false });
  r = await call('GET', '/api/projects', tok.cli);
  ok('deactivated user blocked live (401 account_deactivated)', r.status === 401 && r.body.error === 'account_deactivated');
  r = await call('POST', '/api/auth/login', null, { email:'cli@vest', password:'client12345' });
  ok('deactivated user login refused (403 account_deactivated)', r.status === 403 && r.body.error === 'account_deactivated');

  // Client cannot suspend anyone (admin is consultant-only).
  r = await call('PATCH', '/api/admin/tenants/org-x', tok.con, { status:'active' }); // reactivate first
  await call('PATCH', '/api/admin/users/u-cli/active', tok.con, { active:true });
  r = await call('PATCH', '/api/admin/tenants/org-x', tok.cli, { status:'suspended' });
  ok('client cannot use admin (403 consultant_only)', r.status === 403 && r.body.error === 'consultant_only');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
