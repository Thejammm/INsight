// Local test for Stage 4 Item 2 — relational data model + per-project access
// control. Uses pg-mem (in-memory Postgres) since there is no local PG. Applies
// the real schema, signs real JWTs, and drives the real /api/projects routes
// over HTTP. Run: node _test_item2.js
process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-000';

const fs = require('fs'), path = require('path'), http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { newDb } = require('pg-mem');

let pass = 0, fail = 0;
function ok(name, cond){ (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); }

(async () => {
  // ── in-memory PG + resilient schema apply ──
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  const stmts = schema.split(/;\s*(?:\r?\n|$)/)
    .map(s => s.replace(/^\s*(?:--[^\n]*\n)+/gm, '').trim())  // drop leading comment lines, keep the SQL
    .filter(Boolean);
  const skipped = [];
  for(const s of stmts){
    try { db.public.none(s); } catch(e){ skipped.push((s.split(/\s+/).slice(0,4).join(' ')) + ' … (' + e.message.slice(0,60) + ')'); }
  }
  if(skipped.length){ console.log('note: pg-mem could not apply these valid-PG statements (ignored for the test):'); skipped.forEach(s => console.log('   - ' + s)); }

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  // Inject the pg-mem pool as ../db before the route/middleware load it.
  const dbPath = require.resolve('./db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };

  const { router } = require('./routes/projects');
  const { signSession } = require('./middleware/auth');

  // ── seed organisations (tenants) + users ──
  await pool.query(`INSERT INTO tenants (id, name) VALUES ('org-a','Vest Construction'),('org-b','Coolair Services'),('org-c','Newcastle College')`);
  await pool.query(`INSERT INTO users (id, email, password_hash, tenant_id, role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),
    ('u-a','a@vest','h','org-a','client_user'),
    ('u-b','b@coolair','h','org-b','client_user')`);

  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'A' }),
    b:   signSession({ id:'u-b', email:'b@coolair', role:'client_user', tenant_id:'org-b', display_name:'B' }),
  };

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/projects', router);
  const server = app.listen(0);
  const port = server.address().port;

  function call(method, p, token, body){
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host:'127.0.0.1', port, path:p, method, headers: Object.assign(
        { 'Content-Type':'application/json' }, token ? { 'Cookie':'ahs_session='+token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
        res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ let j=null; try{ j=JSON.parse(d); }catch(e){} resolve({ status:res.statusCode, body:j }); }); });
      req.on('error', e => resolve({ status:0, error:e.message }));
      if(data) req.write(data); req.end();
    });
  }

  // ── tests ──
  // consultant creates a project
  let r = await call('POST','/api/projects', tok.con, { name:'Engineering block refurbishment', ref:'2026018', ribaStage:5 });
  ok('consultant can create a project', r.status===200 && r.body?.project?.id);
  const projId = r.body?.project?.id;
  ok('riba_stage stored', r.body?.project?.riba_stage===5);

  // client cannot create a project
  r = await call('POST','/api/projects', tok.a, { name:'Sneaky' });
  ok('client_user cannot create a project (403)', r.status===403);

  // unauthenticated is rejected
  r = await call('GET','/api/projects', null);
  ok('unauthenticated rejected (401)', r.status===401);

  // consultant appoints org-a as principal_contractor
  r = await call('POST',`/api/projects/${projId}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });
  ok('consultant can appoint an organisation', r.status===200 && r.body?.appointment?.id);

  // invalid role rejected
  r = await call('POST',`/api/projects/${projId}/appointments`, tok.con, { orgId:'org-a', role:'wizard' });
  ok('invalid role rejected (400)', r.status===400);

  // duplicate appointment rejected
  r = await call('POST',`/api/projects/${projId}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });
  ok('duplicate appointment rejected (409)', r.status===409);

  // org-a user sees the project with their role; org-b sees nothing
  r = await call('GET','/api/projects', tok.a);
  ok('org-a user sees the appointed project', r.status===200 && r.body?.projects?.length===1 && r.body.projects[0].id===projId);
  ok('org-a user sees their role on it', r.body?.projects?.[0]?.my_roles?.includes('principal_contractor'));

  r = await call('GET','/api/projects', tok.b);
  ok('org-b user (not appointed) sees no projects', r.status===200 && r.body?.projects?.length===0);

  // per-project access on detail: org-a yes, org-b forbidden
  r = await call('GET',`/api/projects/${projId}`, tok.a);
  ok('org-a user can open the project detail', r.status===200 && r.body?.project?.id===projId);

  r = await call('GET',`/api/projects/${projId}`, tok.b);
  ok('org-b user is FORBIDDEN on the project detail (403)', r.status===403);

  // consultant sees all projects + appointments in detail
  r = await call('GET',`/api/projects/${projId}`, tok.con);
  ok('consultant sees the project appointments', r.status===200 && r.body?.appointments?.length===1 && r.body.appointments[0].org_name==='Vest Construction');

  // second project, appoint org-b — confirms one org sees only its own projects
  r = await call('POST','/api/projects', tok.con, { name:'Student centre extension' });
  const proj2 = r.body?.project?.id;
  await call('POST',`/api/projects/${proj2}/appointments`, tok.con, { orgId:'org-b', role:'contractor' });
  r = await call('GET','/api/projects', tok.a);
  ok('org-a still sees only its 1 project (isolation holds)', r.body?.projects?.length===1);
  r = await call('GET','/api/projects', tok.b);
  ok('org-b now sees only its 1 project', r.body?.projects?.length===1 && r.body.projects[0].id===proj2);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
