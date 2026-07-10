// Per-role reviewer (per project) — pg-mem, real JWTs, real routes.
// Run: node _test_reviewers.js
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

  const { router: projectsRouter } = require('./routes/projects');
  const { router: dutiesRouter } = require('./routes/projectDuties');
  const { signSession } = require('./middleware/auth');

  // org-a = Vest (holds principal_contractor). org-b = Client Org (the reviewer).
  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Vest Construction'),('org-b','Newcastle College Group')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),
    ('u-a','a@vest','h','org-a','client_user'),
    ('u-b','b@ncg','h','org-b','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'Vest User' }),
    b:   signSession({ id:'u-b', email:'b@ncg', role:'client_user', tenant_id:'org-b', display_name:'Karen (NCG)' }),
  };

  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use('/api/project-duties', dutiesRouter);
  const server = app.listen(0); const port = server.address().port;
  function call(m, p, t, b){ return new Promise(r => { const d=b?JSON.stringify(b):null; const rq=http.request({host:'127.0.0.1',port,path:p,method:m,headers:Object.assign({'Content-Type':'application/json'},t?{'Cookie':'ahs_session='+t}:{},d?{'Content-Length':Buffer.byteLength(d)}:{})},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{let j=null;try{j=JSON.parse(s);}catch(e){}r({status:x.statusCode,body:j});});});rq.on('error',()=>r({status:0}));if(d)rq.write(d);rq.end();}); }
  const pcDuties = (body) => (body.duties||[]).filter(d => d.role==='principal_contractor');

  // Setup: project with org-a as PC and org-b as client.
  let r = await call('POST', '/api/projects', tok.con, { name:'Reviewer Project' });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-b', role:'client' });

  // 1) Default: reviewer is AHS → consultant can review; holder cannot.
  r = await call('GET', `/api/projects/${pid}/duties`, tok.con);
  const duty = pcDuties(r.body)[0];
  ok('default reviewerRef is ahs', duty.reviewerRef==='ahs');
  ok('consultant canReview by default', pcDuties(r.body).every(d => d.canReview===true));
  r = await call('GET', `/api/projects/${pid}/duties`, tok.a);
  ok('holder org cannot review its own duties', pcDuties(r.body).every(d => d.canReview===false));

  // 2) Guard: cannot nominate the org that holds the role.
  r = await call('PATCH', `/api/projects/${pid}/reviewers`, tok.con, { role:'principal_contractor', reviewerId:'org-a' });
  ok('reviewer_holds_role rejected (400)', r.status===400 && r.body.error==='reviewer_holds_role');

  // 3) Guard: cannot nominate an org not appointed on the project.
  r = await call('PATCH', `/api/projects/${pid}/reviewers`, tok.con, { role:'principal_contractor', reviewerId:'org-zzz' });
  ok('reviewer_not_appointed rejected (400)', r.status===400 && r.body.error==='reviewer_not_appointed');

  // 4) Client cannot set reviewers (consultant only).
  r = await call('PATCH', `/api/projects/${pid}/reviewers`, tok.b, { role:'principal_contractor', reviewerId:'org-b' });
  ok('client cannot set reviewer (403)', r.status===403);

  // 5) Nominate org-b (the client) as reviewer of PC duties.
  r = await call('PATCH', `/api/projects/${pid}/reviewers`, tok.con, { role:'principal_contractor', reviewerId:'org-b' });
  ok('reviewer set to org-b (200)', r.status===200 && r.body.reviewers.principal_contractor==='org-b');
  r = await call('GET', `/api/projects/${pid}`, tok.con);
  ok('reviewers persisted on project detail', r.body.project.reviewers.principal_contractor==='org-b');

  // 6) Now AHS steps back; the client reviewer takes over.
  r = await call('GET', `/api/projects/${pid}/duties`, tok.con);
  ok('consultant no longer canReview PC (nominated to client)', pcDuties(r.body).every(d => d.canReview===false));
  ok('reviewerRef reflects org-b', pcDuties(r.body).every(d => d.reviewerRef==='org-b'));
  r = await call('GET', `/api/projects/${pid}/duties`, tok.b);
  ok('nominated client reviewer canReview', pcDuties(r.body).every(d => d.canReview===true));
  r = await call('GET', `/api/projects/${pid}/duties`, tok.a);
  ok('holder still cannot review', pcDuties(r.body).every(d => d.canReview===false));

  // 7) Enforcement on the review endpoint itself.
  r = await call('POST', `/api/project-duties/${duty.id}/review`, tok.con, { action:'returned', note:'x' });
  ok('consultant blocked from signing off (403 not_reviewer)', r.status===403 && r.body.error==='not_reviewer');
  r = await call('POST', `/api/project-duties/${duty.id}/review`, tok.a, { action:'returned', note:'x' });
  ok('holder blocked from signing off (403)', r.status===403 && r.body.error==='not_reviewer');
  r = await call('POST', `/api/project-duties/${duty.id}/review`, tok.b, { action:'returned', note:'Needs the CPP attached' });
  ok('nominated client reviewer can return (200)', r.status===200 && r.body.duty.review_status==='returned');

  // 8) Full sign-off with evidence stamps the reviewer org.
  await pool.query(`INSERT INTO documents (id,project_id,name,created_by,updated_by) VALUES ('doc1',$1,'CPP','u-con','u-con')`, [pid]);
  await pool.query(`INSERT INTO document_revisions (id,document_id,rev,status,created_by) VALUES ('rev1','doc1','P01','approved','u-con')`);
  r = await call('POST', `/api/project-duties/${duty.id}/evidence`, tok.a, { revisionId:'rev1' });
  ok('holder attaches evidence (200)', r.status===200);
  r = await call('POST', `/api/project-duties/${duty.id}/review`, tok.a, { action:'reviewed' });
  ok('holder still cannot sign off even after evidence (403)', r.status===403);
  r = await call('POST', `/api/project-duties/${duty.id}/review`, tok.b, { action:'reviewed' });
  ok('client reviewer signs off (200)', r.status===200 && r.body.duty.review_status==='reviewed');
  ok('sign-off stamps reviewer org name', r.body.duty.reviewed_by_org==='Newcastle College Group');
  ok('wording is neutral (no "by AHS")', /^Reviewed:/.test(r.body.wording.reviewed));

  // 9) Reopen: reviewer can; consultant can (admin); holder cannot.
  r = await call('POST', `/api/project-duties/${duty.id}/reopen`, tok.a, {});
  ok('holder cannot reopen (403)', r.status===403);
  r = await call('POST', `/api/project-duties/${duty.id}/reopen`, tok.con, {});
  ok('consultant can reopen as admin (200)', r.status===200 && r.body.duty.review_status==='none');

  // 10) Reset to AHS restores consultant review authority.
  await call('POST', `/api/project-duties/${duty.id}/review`, tok.b, { action:'reviewed' });
  r = await call('PATCH', `/api/projects/${pid}/reviewers`, tok.con, { role:'principal_contractor', reviewerId:'ahs' });
  ok('reviewer reset to ahs clears the key', r.status===200 && r.body.reviewers.principal_contractor===undefined);
  r = await call('GET', `/api/projects/${pid}/duties`, tok.con);
  ok('consultant canReview again after reset', pcDuties(r.body).every(d => d.canReview===true));

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
