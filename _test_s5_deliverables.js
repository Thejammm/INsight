// Local test for Stage 5 Item 1 — design deliverables register. pg-mem, real
// JWTs, real routes over HTTP. Run: node _test_s5_deliverables.js
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
  const { router: deliverablesRouter } = require('./routes/deliverables');
  const { signSession } = require('./middleware/auth');

  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Fineline Architectural'),('org-b','Coolair Services')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@fine','h','org-a','client_user'),('u-b','b@coolair','h','org-b','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    a:   signSession({ id:'u-a', email:'a@fine', role:'client_user', tenant_id:'org-a', display_name:'Fineline User' }),
    b:   signSession({ id:'u-b', email:'b@coolair', role:'client_user', tenant_id:'org-b', display_name:'Coolair User' }),
  };

  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use('/api', documentsRouter);
  app.use('/api', deliverablesRouter);
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

  // Project with Fineline (org-a) appointed as principal designer, at RIBA stage 5.
  let r = await call('POST', '/api/projects', tok.con, { name:'Deliverables Project', ribaStage:5 });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_designer' });

  // ── Create ──
  r = await call('POST', `/api/projects/${pid}/deliverables`, tok.con, { title:'Concept design risk register', discipline:'Architectural', orgId:'org-a', plannedStage:2, status:'outstanding' });
  ok('consultant creates a deliverable', r.status === 200 && !!r.body.deliverable.id);
  const d1 = r.body.deliverable.id;

  r = await call('POST', `/api/projects/${pid}/deliverables`, tok.con, { title:'Structural GA drawings', discipline:'Structural', orgId:'org-a', plannedStage:6, status:'in_progress' });
  const d2 = r.body.deliverable.id;
  ok('a second deliverable is created', r.status === 200 && !!d2);

  r = await call('POST', `/api/projects/${pid}/deliverables`, tok.con, { title:'' });
  ok('title is required (400)', r.status === 400 && r.body.error === 'title_required');

  // ── Overdue derivation (project at stage 5) ──
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  ok('GET returns both + currentStage 5', r.status === 200 && r.body.deliverables.length === 2 && r.body.currentStage === 5);
  const byId = {}; r.body.deliverables.forEach(x => byId[x.id] = x);
  ok('stage-2 outstanding deliverable is OVERDUE at stage 5', byId[d1].overdue === true);
  ok('stage-6 deliverable is NOT overdue at stage 5', byId[d2].overdue === false);
  ok('plannedStageName resolved', byId[d1].plannedStageName === 'Concept Design');

  // ── Mark issued -> no longer overdue ──
  r = await call('PATCH', `/api/deliverables/${d1}`, tok.con, { status:'issued' });
  ok('mark issued (200)', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  ok('issued deliverable is no longer overdue', r.body.deliverables.find(x => x.id === d1).overdue === false);

  // ── Owning org can edit; other org cannot ──
  r = await call('PATCH', `/api/deliverables/${d1}`, tok.a, { status:'accepted' });
  ok('owning org (Fineline) can edit its deliverable', r.status === 200);
  r = await call('PATCH', `/api/deliverables/${d1}`, tok.b, { status:'outstanding' });
  ok('other org cannot edit (403)', r.status === 403);
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.b);
  ok('unrelated org cannot even read the project (403)', r.status === 403);

  // ── Evidence link validation ──
  r = await call('POST', `/api/projects/${pid}/documents`, tok.con, { docRef:'STR-001', name:'Structural calcs' });
  const did = r.body.document.id;
  r = await call('POST', `/api/documents/${did}/revisions`, tok.con, { rev:'P01', status:'approved' });
  const rid = r.body.revision.id;
  r = await call('PATCH', `/api/deliverables/${d2}`, tok.con, { revisionId:rid });
  ok('link a same-project revision as evidence (200)', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  const withEv = r.body.deliverables.find(x => x.id === d2);
  ok('evidence surfaced with name + documentId', withEv.evidence && /STR-001/.test(withEv.evidence.name) && withEv.evidence.documentId === did);
  r = await call('PATCH', `/api/deliverables/${d2}`, tok.con, { revisionId:'not-a-real-rev' });
  ok('a non-project / bogus revision is rejected (400)', r.status === 400 && r.body.error === 'revision_not_in_project');

  // ── Delete ──
  r = await call('DELETE', `/api/deliverables/${d1}`, tok.b);
  ok('other org cannot delete (403)', r.status === 403);
  r = await call('DELETE', `/api/deliverables/${d1}`, tok.con);
  ok('consultant deletes a deliverable', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  ok('register now has one deliverable', r.body.deliverables.length === 1);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
