// Local test for Stage 6 — optimistic concurrency on the duty review loop.
// A write carrying a stale expectedUpdatedAt is rejected 409; a matching one
// succeeds; omitting it keeps the old behaviour. Run: node _test_s6_concurrency.js
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
  const { router: projectsRouter } = require('./routes/projects');
  const { router: dutiesRouter } = require('./routes/projectDuties');
  const { router: documentsRouter } = require('./routes/documents');
  const { signSession } = require('./middleware/auth');

  await seedDutyTemplates();
  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Vest Construction')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@vest','h','org-a','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'Vest' }),
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

  let r = await call('POST', '/api/projects', tok.con, { name:'Concurrency Project' });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });
  r = await call('GET', `/api/projects/${pid}/duties`, tok.a);
  const duty = r.body.duties[0];
  ok('duties GET returns updatedAt', !!duty.updatedAt);

  // A write WITHOUT expectedUpdatedAt still works (back-compat).
  r = await call('PATCH', `/api/project-duties/${duty.id}`, tok.a, { discharge:'Method A' });
  ok('write without expectation succeeds (back-compat)', r.status === 200);

  // Re-read: updatedAt has moved on.
  r = await call('GET', `/api/projects/${pid}/duties`, tok.a);
  const fresh = r.body.duties.find(d => d.id === duty.id);
  ok('updatedAt changed after the write', fresh.updatedAt !== duty.updatedAt);

  // A write with the STALE (original) stamp is rejected 409.
  r = await call('PATCH', `/api/project-duties/${duty.id}`, tok.a, { discharge:'Method B', expectedUpdatedAt: duty.updatedAt });
  ok('stale expectedUpdatedAt is rejected (409)', r.status === 409 && r.body.error === 'stale');

  // A write with the CURRENT stamp succeeds.
  r = await call('PATCH', `/api/project-duties/${duty.id}`, tok.a, { discharge:'Method C', expectedUpdatedAt: fresh.updatedAt });
  ok('current expectedUpdatedAt succeeds', r.status === 200);

  // The stale write did NOT overwrite: value is Method C, not Method B.
  r = await call('GET', `/api/projects/${pid}/duties`, tok.a);
  ok('no lost update — value is Method C', r.body.duties.find(d => d.id === duty.id).discharge === 'Method C');

  // Attach evidence so review is possible, then test review concurrency.
  const doc = await call('POST', `/api/projects/${pid}/documents`, tok.con, { name:'Evidence doc' });
  const rev = await call('POST', `/api/documents/${doc.body.document.id}/revisions`, tok.con, { rev:'A', status:'approved' });
  await call('POST', `/api/project-duties/${duty.id}/evidence`, tok.a, { revisionId: rev.body.revision.id });
  r = await call('GET', `/api/projects/${pid}/duties`, tok.con);
  const withEv = r.body.duties.find(d => d.id === duty.id);
  // duty.updatedAt is the very first stamp — long stale by now.
  r = await call('POST', `/api/project-duties/${duty.id}/review`, tok.con, { action:'reviewed', expectedUpdatedAt: duty.updatedAt });
  ok('review with a stale stamp is rejected (409)', r.status === 409 && r.body.error === 'stale');
  r = await call('POST', `/api/project-duties/${duty.id}/review`, tok.con, { action:'reviewed', expectedUpdatedAt: withEv.updatedAt });
  ok('review with the current stamp succeeds', r.status === 200);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
