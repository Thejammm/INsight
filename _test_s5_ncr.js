// Local test for Stage 5 Item 3 — non-conformance register. pg-mem, real JWTs,
// real routes over HTTP. Run: node _test_s5_ncr.js
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
  const { router: ncrRouter } = require('./routes/ncr');
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
  app.use('/api', ncrRouter);
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

  let r = await call('POST', '/api/projects', tok.con, { name:'NCR Project' });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });

  // ── Raise ──
  r = await call('POST', `/api/projects/${pid}/ncrs`, tok.con, { ncrRef:'NCR-001', title:'Rebar cover below tolerance', description:'Cover 20mm vs 40mm spec', severity:'major', orgId:'org-a', status:'open' });
  ok('consultant raises a major NCR', r.status === 200 && !!r.body.ncr.id);
  const n1 = r.body.ncr.id;
  r = await call('POST', `/api/projects/${pid}/ncrs`, tok.con, { title:'Snagging: paint finish', severity:'minor', orgId:'org-a', status:'open' });
  const n2 = r.body.ncr.id;
  ok('a minor NCR is raised', r.status === 200 && !!n2);
  r = await call('POST', `/api/projects/${pid}/ncrs`, tok.con, { title:'' });
  ok('title is required (400)', r.status === 400 && r.body.error === 'title_required');

  // ── Ordering: open majors first, closed last ──
  r = await call('POST', `/api/projects/${pid}/ncrs`, tok.con, { title:'Old issue', severity:'major', status:'closed', orgId:'org-a' });
  const n3 = r.body.ncr.id;
  r = await call('GET', `/api/projects/${pid}/ncrs`, tok.con);
  ok('GET returns all three', r.status === 200 && r.body.ncrs.length === 3);
  ok('open major sorts first', r.body.ncrs[0].id === n1);
  ok('closed sorts last', r.body.ncrs[2].id === n3);
  ok('open flag reflects status', r.body.ncrs.find(x=>x.id===n1).open === true && r.body.ncrs.find(x=>x.id===n3).open === false);

  // ── Corrective action + close with evidence ──
  r = await call('POST', `/api/projects/${pid}/documents`, tok.con, { docRef:'INSP-9', name:'Remedial inspection' });
  const did = r.body.document.id;
  r = await call('POST', `/api/documents/${did}/revisions`, tok.con, { rev:'A', status:'approved' });
  const rid = r.body.revision.id;
  r = await call('PATCH', `/api/ncrs/${n1}`, tok.con, { status:'in_progress', correctiveAction:'Break out and recast affected zone' });
  ok('record corrective action + move to in_progress (200)', r.status === 200);
  r = await call('PATCH', `/api/ncrs/${n1}`, tok.con, { status:'closed', revisionId:rid });
  ok('close with evidence (200)', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/ncrs`, tok.con);
  const closed = r.body.ncrs.find(x=>x.id===n1);
  ok('closed NCR carries corrective action + evidence', closed.status==='closed' && /Break out/.test(closed.correctiveAction) && closed.evidence && /INSP-9/.test(closed.evidence.name));
  r = await call('PATCH', `/api/ncrs/${n1}`, tok.con, { revisionId:'bogus' });
  ok('bogus evidence revision rejected (400)', r.status === 400 && r.body.error === 'revision_not_in_project');

  // ── Access control ──
  r = await call('PATCH', `/api/ncrs/${n2}`, tok.a, { status:'closed' });
  ok('responsible org (Vest) can edit', r.status === 200);
  r = await call('PATCH', `/api/ncrs/${n2}`, tok.b, { status:'open' });
  ok('other org cannot edit (403)', r.status === 403);
  r = await call('GET', `/api/projects/${pid}/ncrs`, tok.b);
  ok('unrelated org cannot read (403)', r.status === 403);
  r = await call('DELETE', `/api/ncrs/${n2}`, tok.b);
  ok('other org cannot delete (403)', r.status === 403);
  r = await call('DELETE', `/api/ncrs/${n2}`, tok.con);
  ok('consultant deletes an NCR', r.status === 200);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
