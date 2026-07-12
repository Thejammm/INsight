// Demo-data seeder (POST /api/admin/demo) — pg-mem, real JWTs, real routes.
// Run: node _test_demo.js
process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-000';

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

  const { seedDutyTemplates } = require('./db/seedDuties');
  await seedDutyTemplates();

  const adminRouter = require('./routes/admin');
  const { router: projectsRouter } = require('./routes/projects');
  const { signSession } = require('./middleware/auth');
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role,display_name) VALUES ('u-con','con@ahs','h',NULL,'consultant','AHS'),('u-cli','c@x','h',NULL,'client_user','Cli')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    cli: signSession({ id:'u-cli', email:'c@x', role:'client_user', tenant_id:null, display_name:'Cli' }),
  };
  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/projects', projectsRouter);
  const server = app.listen(0); const port = server.address().port;
  function call(m, p, t, b){ return new Promise(r => { const d=b?JSON.stringify(b):null; const rq=http.request({host:'127.0.0.1',port,path:p,method:m,headers:Object.assign({'Content-Type':'application/json'},t?{'Cookie':'ahs_session='+t}:{},d?{'Content-Length':Buffer.byteLength(d)}:{})},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{let j=null;try{j=JSON.parse(s);}catch(e){}r({status:x.statusCode,body:j});});});rq.on('error',()=>r({status:0}));if(d)rq.write(d);rq.end();}); }
  const cnt = (duties, role) => { const c={}; duties.filter(d=>d.role===role).forEach(d=>{c[d.status]=(c[d.status]||0)+1;}); return c; };

  // Client user cannot seed the demo (consultant only).
  let r = await call('POST', '/api/admin/demo', tok.cli);
  ok('client_user cannot seed demo (403)', r.status === 403);

  // Consultant seeds it.
  r = await call('POST', '/api/admin/demo', tok.con);
  ok('consultant seeds demo (200 + projectId)', r.status === 200 && !!r.body.projectId);
  const pid = r.body.projectId;

  r = await call('GET', `/api/projects/${pid}`, tok.con);
  ok('project is the demo project', r.body.project.name === 'Demo: Kingsgate office refurbishment' && r.body.project.ref === 'DEMO');
  ok('three duty holders appointed', r.body.appointments.length === 3);
  ok('principal designer delegated to the client', r.body.project.reviewers.principal_designer === 'demo-client');

  r = await call('GET', `/api/projects/${pid}/duties`, tok.con);
  const duties = r.body.duties;
  ok('client duties all signed off', Object.keys(cnt(duties,'client')).join() === 'reviewed');
  ok('principal contractor duties all signed off', Object.keys(cnt(duties,'principal_contractor')).join() === 'reviewed');
  ok('principal designer duties awaiting the client', Object.keys(cnt(duties,'principal_designer')).join() === 'awaiting_review');
  ok('signed duties carry evidence + AHS org stamp', duties.some(d => d.status==='reviewed' && d.evidence.length && d.reviewedByOrg==='AHS'));

  // Idempotent: re-seeding replaces, does not duplicate.
  r = await call('POST', '/api/admin/demo', tok.con);
  ok('re-seed returns 200', r.status === 200);
  r = await call('GET', '/api/projects', tok.con);
  ok('still exactly one DEMO project after re-seed', r.body.projects.filter(p => p.ref === 'DEMO').length === 1);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
