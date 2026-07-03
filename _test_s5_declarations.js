// Local test for Stage 5 Item 5 — declarations register + gate. pg-mem, real
// JWTs, real routes over HTTP. Run: node _test_s5_declarations.js
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
  const { router: declRouter } = require('./routes/declarations');
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
  app.use('/api', declRouter);
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

  let r = await call('POST', '/api/projects', tok.con, { name:'Declarations Project' });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'br_principal_designer' });

  // ── Create ──
  r = await call('POST', `/api/projects/${pid}/declarations`, tok.con, { title:'PD competence declaration (BR Part 2A)', orgId:'org-a', status:'outstanding' });
  ok('consultant adds a declaration', r.status === 200 && !!r.body.declaration.id);
  const d1 = r.body.declaration.id;
  r = await call('POST', `/api/projects/${pid}/declarations`, tok.con, { title:'Client competence declaration', orgId:'org-a', status:'outstanding' });
  const d2 = r.body.declaration.id;
  r = await call('POST', `/api/projects/${pid}/declarations`, tok.con, { title:'' });
  ok('title required (400)', r.status === 400 && r.body.error === 'title_required');

  // ── Gate reflects state ──
  r = await call('GET', `/api/projects/${pid}/declarations`, tok.con);
  ok('gate: 0 of 2 provided, not passed', r.body.gate.required === 2 && r.body.gate.provided === 0 && r.body.gate.passed === false);

  // Provide the first (link a stored file)
  r = await call('POST', `/api/projects/${pid}/documents`, tok.con, { docRef:'PD-DEC', name:'PD competence declaration' });
  const did = r.body.document.id;
  r = await call('POST', `/api/documents/${did}/revisions`, tok.con, { rev:'signed', status:'approved', link:'https://store/pd-dec.pdf' });
  const rid = r.body.revision.id;
  r = await call('PATCH', `/api/declarations/${d1}`, tok.con, { status:'provided', revisionId:rid });
  ok('mark provided + link stored file (200)', r.status === 200);
  r = await call('GET', `/api/projects/${pid}/declarations`, tok.con);
  ok('gate: 1 of 2 provided, still not passed', r.body.gate.provided === 1 && r.body.gate.passed === false);
  const withFile = r.body.declarations.find(x => x.id === d1);
  ok('stored file surfaced with name + link', withFile.file && /PD-DEC/.test(withFile.file.name) && withFile.file.link === 'https://store/pd-dec.pdf');

  // Provide the second -> gate passes
  r = await call('PATCH', `/api/declarations/${d2}`, tok.con, { status:'provided', revisionId:rid });
  r = await call('GET', `/api/projects/${pid}/declarations`, tok.con);
  ok('gate passes when all provided', r.body.gate.passed === true && r.body.gate.provided === 2);

  // n/a excludes from the gate
  r = await call('POST', `/api/projects/${pid}/declarations`, tok.con, { title:'Not needed here', status:'na', orgId:'org-a' });
  r = await call('GET', `/api/projects/${pid}/declarations`, tok.con);
  ok('n/a declaration is excluded from the gate', r.body.gate.required === 2 && r.body.gate.passed === true);

  // ── Evidence validation + access control ──
  r = await call('PATCH', `/api/declarations/${d1}`, tok.con, { revisionId:'bogus' });
  ok('bogus stored-file revision rejected (400)', r.status === 400 && r.body.error === 'revision_not_in_project');
  r = await call('PATCH', `/api/declarations/${d1}`, tok.a, { notes:'ok' });
  ok('owning org (Fineline) can edit', r.status === 200);
  r = await call('PATCH', `/api/declarations/${d1}`, tok.b, { status:'outstanding' });
  ok('other org cannot edit (403)', r.status === 403);
  r = await call('GET', `/api/projects/${pid}/declarations`, tok.b);
  ok('unrelated org cannot read (403)', r.status === 403);
  r = await call('DELETE', `/api/declarations/${d1}`, tok.b);
  ok('other org cannot delete (403)', r.status === 403);
  r = await call('DELETE', `/api/declarations/${d1}`, tok.con);
  ok('consultant deletes a declaration', r.status === 200);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
