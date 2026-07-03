// Local test for Stage 5 Item 2 — inspection & test plan register. pg-mem, real
// JWTs, real routes over HTTP. Run: node _test_s5_itp.js
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
  const { router: itpRouter } = require('./routes/itp');
  const { signSession } = require('./middleware/auth');

  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Vest Construction'),('org-b','Coolair Services')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@vest','h','org-a','client_user'),('u-b','b@coolair','h','org-b','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'Vest User' }),
    b:   signSession({ id:'u-b', email:'b@coolair', role:'client_user', tenant_id:'org-b', display_name:'Coolair User' }),
  };

  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use('/api', documentsRouter);
  app.use('/api', itpRouter);
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

  // Project with Vest (org-a) appointed as principal contractor, at RIBA stage 6.
  let r = await call('POST', '/api/projects', tok.con, { name:'ITP Project', ribaStage:6 });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });

  // ── Create ──
  r = await call('POST', `/api/projects/${pid}/itp`, tok.con, { title:'Reinforcement fixing before pour', section:'Concrete', reference:'Drg S-201', controlPoint:'hold', orgId:'org-a', plannedStage:5, status:'planned' });
  ok('consultant creates an ITP item', r.status === 200 && !!r.body.item.id);
  const i1 = r.body.item.id;
  r = await call('POST', `/api/projects/${pid}/itp`, tok.con, { title:'Ductwork pressure test', section:'M&E', controlPoint:'witness', orgId:'org-a', plannedStage:7, status:'in_progress' });
  const i2 = r.body.item.id;
  ok('a second ITP item is created', r.status === 200 && !!i2);
  r = await call('POST', `/api/projects/${pid}/itp`, tok.con, { title:'' });
  ok('title is required (400)', r.status === 400 && r.body.error === 'title_required');
  r = await call('POST', `/api/projects/${pid}/itp`, tok.con, { title:'Bad control point', controlPoint:'nonsense' });
  ok('invalid control point falls back to record (not rejected)', r.status === 200);

  // ── Overdue derivation (project at stage 6) ──
  r = await call('GET', `/api/projects/${pid}/itp`, tok.con);
  ok('GET returns items + currentStage 6', r.status === 200 && r.body.currentStage === 6);
  const byId = {}; r.body.items.forEach(x => byId[x.id] = x);
  ok('stage-5 planned item is OVERDUE at stage 6', byId[i1].overdue === true);
  ok('stage-7 item is NOT overdue at stage 6', byId[i2].overdue === false);
  ok('control point + stage name resolved', byId[i1].controlPoint === 'hold' && byId[i1].plannedStageName === 'Manufacturing and Construction');

  // ── Passed clears overdue; failed sets the quality flag ──
  await call('PATCH', `/api/itp/${i1}`, tok.con, { status:'passed' });
  r = await call('GET', `/api/projects/${pid}/itp`, tok.con);
  ok('passed item is no longer overdue', r.body.items.find(x => x.id === i1).overdue === false);
  await call('PATCH', `/api/itp/${i2}`, tok.con, { status:'failed' });
  r = await call('GET', `/api/projects/${pid}/itp`, tok.con);
  ok('failed item carries the quality flag', r.body.items.find(x => x.id === i2).failed === true);

  // ── Access control ──
  r = await call('PATCH', `/api/itp/${i1}`, tok.a, { status:'na' });
  ok('owning org (Vest) can edit', r.status === 200);
  r = await call('PATCH', `/api/itp/${i1}`, tok.b, { status:'planned' });
  ok('other org cannot edit (403)', r.status === 403);
  r = await call('GET', `/api/projects/${pid}/itp`, tok.b);
  ok('unrelated org cannot read the project (403)', r.status === 403);

  // ── Evidence link validation ──
  r = await call('POST', `/api/projects/${pid}/documents`, tok.con, { docRef:'TC-001', name:'Pressure test certificate' });
  const did = r.body.document.id;
  r = await call('POST', `/api/documents/${did}/revisions`, tok.con, { rev:'01', status:'approved' });
  const rid = r.body.revision.id;
  r = await call('PATCH', `/api/itp/${i2}`, tok.con, { revisionId:rid });
  ok('link a same-project revision as evidence (200)', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/itp`, tok.con);
  ok('evidence surfaced with name + documentId', (function(){ const it = r.body.items.find(x => x.id === i2); return it.evidence && /TC-001/.test(it.evidence.name) && it.evidence.documentId === did; })());
  r = await call('PATCH', `/api/itp/${i2}`, tok.con, { revisionId:'bogus' });
  ok('a bogus revision is rejected (400)', r.status === 400 && r.body.error === 'revision_not_in_project');

  // ── Delete ──
  r = await call('DELETE', `/api/itp/${i1}`, tok.b);
  ok('other org cannot delete (403)', r.status === 403);
  r = await call('DELETE', `/api/itp/${i1}`, tok.con);
  ok('consultant deletes an item', r.status === 200);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
