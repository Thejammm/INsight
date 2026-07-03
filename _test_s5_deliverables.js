// Round 2 Part A1 — design deliverables assurance/gate model. pg-mem, real JWTs.
// Run: node _test_s5_deliverables.js
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

  const { router: projectsRouter } = require('./routes/projects');
  const { router: documentsRouter } = require('./routes/documents');
  const { router: delRouter } = require('./routes/deliverables');
  const { migrateQuality } = require('./db/migrateQuality');
  const { signSession } = require('./middleware/auth');

  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Fineline Architectural'),('org-b','Coolair Services')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@fine','h','org-a','client_user'),('u-b','b@coolair','h','org-b','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    a:   signSession({ id:'u-a', email:'a@fine', role:'client_user', tenant_id:'org-a', display_name:'Fineline' }),
    b:   signSession({ id:'u-b', email:'b@coolair', role:'client_user', tenant_id:'org-b', display_name:'Coolair' }),
  };
  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/projects', projectsRouter); app.use('/api', documentsRouter); app.use('/api', delRouter);
  const server = app.listen(0); const port = server.address().port;
  function call(m, p, t, b){ return new Promise(r => { const d=b?JSON.stringify(b):null; const rq=http.request({host:'127.0.0.1',port,path:p,method:m,headers:Object.assign({'Content-Type':'application/json'},t?{'Cookie':'ahs_session='+t}:{},d?{'Content-Length':Buffer.byteLength(d)}:{})},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{let j=null;try{j=JSON.parse(s);}catch(e){}r({status:x.statusCode,body:j});});});rq.on('error',()=>r({status:0}));if(d)rq.write(d);rq.end();}); }

  // Migration: an old-model deliverable maps to a gate_status.
  let r = await call('POST', '/api/projects', tok.con, { name:'Del Project', ribaStage:5 });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_designer' });
  await pool.query(`INSERT INTO design_deliverables (id,project_id,org_id,title,status,planned_stage,created_by,updated_by) VALUES ('leg1',$1,'org-a','Legacy issued','issued',2,'u-con','u-con'),('leg2',$1,'org-a','Legacy outstanding','outstanding',2,'u-con','u-con')`, [pid]);
  await migrateQuality();
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  const leg1 = r.body.deliverables.find(d => d.id==='leg1'), leg2 = r.body.deliverables.find(d => d.id==='leg2');
  ok('migration: issued -> reviewed', leg1.gateStatus === 'reviewed');
  ok('migration: outstanding -> not_submitted', leg2.gateStatus === 'not_submitted');

  // Seed defaults into an empty register (fresh project).
  r = await call('POST', '/api/projects', tok.con, { name:'Empty Project', ribaStage:4 });
  const pid2 = r.body.project.id;
  await call('POST', `/api/projects/${pid2}/appointments`, tok.con, { orgId:'org-a', role:'principal_designer' });
  r = await call('POST', `/api/projects/${pid2}/deliverables/seed-defaults`, tok.con);
  ok('seed-defaults adds the standard list', r.status === 200 && r.body.added >= 8);
  r = await call('POST', `/api/projects/${pid2}/deliverables/seed-defaults`, tok.con);
  ok('seed-defaults refuses when not empty (409)', r.status === 409);
  r = await call('GET', `/api/projects/${pid2}/deliverables`, tok.con);
  ok('a compliance-critical deliverable is flagged', r.body.deliverables.some(d => d.complianceCritical));

  // Create + gate flow.
  r = await call('POST', `/api/projects/${pid}/deliverables`, tok.con, { title:'Fire strategy', discipline:'Fire', orgId:'org-a', plannedStage:3, complianceCritical:true, currentRevision:'P01' });
  const did = r.body.deliverable.id;
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  let d = r.body.deliverables.find(x => x.id===did);
  ok('new deliverable starts not_submitted', d.gateStatus === 'not_submitted');
  ok('stage-3 not-submitted is OVERDUE at stage 5', d.overdue === true);

  // Owner submits for gate review at a stage, recording the revision.
  r = await call('POST', `/api/deliverables/${did}/submit`, tok.a, { revision:'P02', stage:3 });
  ok('owner submits for gate review', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  d = r.body.deliverables.find(x => x.id===did);
  ok('gate is submitted with revision + stage recorded', d.gateStatus==='submitted' && d.gateRevision==='P02' && d.gateStage===3);

  // Client cannot review (consultant only); returned needs a note.
  r = await call('POST', `/api/deliverables/${did}/review`, tok.a, { action:'reviewed' });
  ok('client cannot review (403)', r.status === 403);
  r = await call('POST', `/api/deliverables/${did}/review`, tok.con, { action:'returned' });
  ok('return without a note is rejected (400)', r.status === 400);
  r = await call('POST', `/api/deliverables/${did}/review`, tok.con, { action:'returned', note:'Missing cavity barriers detail' });
  ok('consultant returns with reasons', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  d = r.body.deliverables.find(x => x.id===did);
  ok('returned records the note + reviewer', d.gateStatus==='returned' && /cavity/.test(d.reviewNote) && !!d.reviewedBy);
  ok('returned (not reviewed) still counts as overdue', d.overdue === true);

  // Resubmit + review suitable -> clears overdue.
  await call('POST', `/api/deliverables/${did}/submit`, tok.a, { revision:'P03', stage:3 });
  r = await call('POST', `/api/deliverables/${did}/review`, tok.con, { action:'reviewed' });
  ok('review suitable returns the non-transfer wording', r.status===200 && /does not transfer/.test(r.body.wording.nonTransfer));
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  d = r.body.deliverables.find(x => x.id===did);
  ok('reviewed (suitable) clears the overdue flag', d.gateStatus==='reviewed' && d.overdue===false);

  // Reopen.
  r = await call('POST', `/api/deliverables/${did}/reopen`, tok.con);
  ok('consultant reopens to not_submitted', r.status===200);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
