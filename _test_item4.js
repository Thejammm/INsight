// Local test for Stage 4 Item 4 — the duty review loop. pg-mem, real JWTs,
// real routes over HTTP. Run: node _test_item4.js
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
    .forEach(s => { try { db.public.none(s); } catch(e){ /* emulator limits (functional idx / some ALTERs) */ } });

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const dbPath = require.resolve('./db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };

  const { seedDutyTemplates } = require('./db/seedDuties');
  const { router: projectsRouter } = require('./routes/projects');
  const { router: dutiesRouter } = require('./routes/projectDuties');
  const { router: documentsRouter } = require('./routes/documents');
  const { signSession } = require('./middleware/auth');

  await seedDutyTemplates();
  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Vest Construction'),('org-b','Coolair Services')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@vest','h','org-a','client_user'),('u-b','b@coolair','h','org-b','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'Simon Archer (AHS)' }),
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'Vest User' }),
    b:   signSession({ id:'u-b', email:'b@coolair', role:'client_user', tenant_id:'org-b', display_name:'Coolair User' }),
  };

  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use('/api/project-duties', dutiesRouter);
  app.use('/api', documentsRouter);
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
  const dutiesOf = async (projId, token) => (await call('GET', `/api/projects/${projId}/duties`, token)).body;
  const findDuty = (list, id) => (list.duties||[]).find(d => d.id === id);

  // consultant creates a project + appoints org-a as principal contractor (15 duties)
  let r = await call('POST', '/api/projects', tok.con, { name:'Engineering block refurbishment', ref:'2026018' });
  const projId = r.body.project.id;
  r = await call('POST', `/api/projects/${projId}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });
  ok('appointing an org instantiates its duties (15)', r.status===200 && r.body?.dutiesCreated===15);
  const cnt = await pool.query('SELECT COUNT(*) AS n FROM project_duties');
  ok('15 project_duties rows created', Number(cnt.rows[0].n) === 15);

  // org-a sees them; all Outstanding; wording present; org-b forbidden
  let d = await dutiesOf(projId, tok.a);
  ok('org-a sees its 15 duties', d?.duties?.length === 15);
  ok('all start Outstanding', d.duties.every(x => x.status === 'outstanding'));
  ok('reviewed wording is the confirmed text', d.wording?.reviewed === 'Reviewed by AHS: evidence provided appears to satisfy the requirement');
  ok('non-transfer statement present', /does not transfer or discharge the dutyholder/.test(d.wording?.nonTransfer || ''));
  r = await call('GET', `/api/projects/${projId}/duties`, tok.b);
  ok('org-b (not appointed) forbidden on duties (403)', r.status === 403);

  const dutyId = d.duties[0].id;
  const otherDutyId = d.duties[1].id;

  // record discharge -> Evidence outstanding
  r = await call('PATCH', `/api/project-duties/${dutyId}`, tok.a, { discharge:'Addressed in the construction phase plan.' });
  ok('org-a records a discharge method', r.status === 200);
  d = await dutiesOf(projId, tok.a);
  ok('status now Evidence outstanding', findDuty(d, dutyId).status === 'evidence_outstanding');

  // org-b cannot edit org-a's duty
  r = await call('PATCH', `/api/project-duties/${dutyId}`, tok.b, { discharge:'hax' });
  ok('org-b cannot edit org-a duty (403)', r.status === 403);

  // add a document reference + a revision, then link the revision as evidence
  r = await call('POST', `/api/projects/${projId}/documents`, tok.a, { docRef:'CPP-001', name:'Construction phase plan' });
  const evDocId = r.body?.document?.id;
  ok('org-a adds a document reference', r.status === 200 && !!evDocId);
  r = await call('POST', `/api/documents/${evDocId}/revisions`, tok.a, { rev:'Rev C', status:'approved' });
  const evRevId = r.body?.revision?.id;
  ok('org-a adds a revision', r.status === 200 && !!evRevId);
  r = await call('POST', `/api/project-duties/${dutyId}/evidence`, tok.a, { revisionId: evRevId });
  ok('org-a links the revision as duty evidence', r.status === 200);
  d = await dutiesOf(projId, tok.a);
  ok('status now Awaiting AHS review', findDuty(d, dutyId).status === 'awaiting_review');

  // client cannot review
  r = await call('POST', `/api/project-duties/${dutyId}/review`, tok.a, { action:'reviewed' });
  ok('client user cannot review (403)', r.status === 403);

  // consultant reviews (accept) -> Reviewed, named reviewer recorded
  r = await call('POST', `/api/project-duties/${dutyId}/review`, tok.con, { action:'reviewed' });
  ok('consultant reviews and accepts', r.status === 200 && r.body?.duty?.review_status === 'reviewed');
  ok('named reviewer recorded', r.body?.duty?.reviewed_by === 'Simon Archer (AHS)' && !!r.body?.duty?.reviewed_at);
  d = await dutiesOf(projId, tok.a);
  ok('status now Reviewed by AHS', findDuty(d, dutyId).status === 'reviewed');

  // cannot accept a duty with no evidence
  r = await call('POST', `/api/project-duties/${otherDutyId}/review`, tok.con, { action:'reviewed' });
  ok('cannot accept a duty with no evidence (400)', r.status === 400);

  // returned requires a note
  r = await call('POST', `/api/project-duties/${otherDutyId}/review`, tok.con, { action:'returned' });
  ok('return without a note rejected (400)', r.status === 400);
  r = await call('POST', `/api/project-duties/${otherDutyId}/review`, tok.con, { action:'returned', note:'Please add the temporary works design check.' });
  ok('consultant returns with a note', r.status === 200 && r.body?.duty?.review_status === 'returned');
  d = await dutiesOf(projId, tok.a);
  ok('status now Returned by AHS with the note', findDuty(d, otherDutyId).status === 'returned' &&
     /temporary works/.test(findDuty(d, otherDutyId).reviewNote || ''));

  // reopen clears the review
  r = await call('POST', `/api/project-duties/${dutyId}/reopen`, tok.con);
  ok('consultant can reopen a reviewed duty', r.status === 200);
  d = await dutiesOf(projId, tok.a);
  ok('reopened duty returns to Awaiting review (evidence kept)', findDuty(d, dutyId).status === 'awaiting_review');

  // delete a project cascades to its appointments and duties (used for clean
  // live verification). Client user cannot delete.
  r = await call('DELETE', `/api/projects/${projId}`, tok.a);
  ok('client user cannot delete a project (403)', r.status === 403);
  r = await call('DELETE', `/api/projects/${projId}`, tok.con);
  ok('consultant deletes the project', r.status === 200);
  const left = await pool.query('SELECT COUNT(*) AS n FROM project_duties');
  ok('deleting the project cascades its duties away (0 left)', Number(left.rows[0].n) === 0);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
