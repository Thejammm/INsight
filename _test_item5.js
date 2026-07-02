// Local test for Stage 4 Item 5 — document register + duty evidence as links to
// register entries. pg-mem, real JWTs, real routes over HTTP. Run: node _test_item5.js
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

  // Project 1: org-a is principal contractor. Project 2: org-b.
  let r = await call('POST', '/api/projects', tok.con, { name:'Project One' });   const p1 = r.body.project.id;
  await call('POST', `/api/projects/${p1}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });
  r = await call('POST', '/api/projects', tok.con, { name:'Project Two' });       const p2 = r.body.project.id;
  await call('POST', `/api/projects/${p2}/appointments`, tok.con, { orgId:'org-b', role:'contractor' });

  // ── reference library: document references + revisions ──
  r = await call('POST', `/api/projects/${p1}/documents`, tok.a, { docRef:'STR-CALC-001', name:'Structural calculations', category:'Structural' });
  const doc1 = r.body?.document?.id;
  ok('appointed org adds a document reference', r.status===200 && doc1 && r.body.document.org_id==='org-a');
  ok('reference has a code + empty revisions', r.body?.document?.doc_ref==='STR-CALC-001' && Array.isArray(r.body.document.revisions) && r.body.document.revisions.length===0);

  r = await call('POST', `/api/projects/${p1}/documents`, tok.b, { name:'sneaky' });
  ok('org not on the project cannot add a reference (403)', r.status===403);
  r = await call('POST', `/api/projects/${p1}/documents`, tok.a, { name:'' });
  ok('reference title required (400)', r.status===400);

  // revisions
  r = await call('POST', `/api/documents/${doc1}/revisions`, tok.a, { rev:'Rev A', status:'for_review', revDate:'2026-05-01', link:'https://dms/rev-a' });
  const revA = r.body?.revision?.id;
  ok('add a revision', r.status===200 && revA && r.body.revision.rev==='Rev A' && r.body.revision.status==='for_review');
  r = await call('POST', `/api/documents/${doc1}/revisions`, tok.a, { rev:'Rev B', status:'approved' });
  const revB = r.body?.revision?.id;
  ok('add a second revision', r.status===200 && !!revB);
  r = await call('POST', `/api/documents/${doc1}/revisions`, tok.a, { rev:'Rev A' });
  ok('duplicate revision label rejected (409)', r.status===409);
  r = await call('POST', `/api/documents/${doc1}/revisions`, tok.a, { rev:'' });
  ok('revision label required (400)', r.status===400);
  r = await call('POST', `/api/documents/${doc1}/revisions`, tok.b, { rev:'Rev X' });
  ok('other org cannot add a revision (403)', r.status===403);

  r = await call('GET', `/api/projects/${p1}/documents`, tok.a);
  ok('library nests revisions under the reference', r.status===200 && r.body.documents[0].revisions.length===2);
  r = await call('GET', `/api/projects/${p1}/documents`, tok.b);
  ok('non-participant cannot read the library (403)', r.status===403);

  r = await call('PATCH', `/api/revisions/${revA}`, tok.a, { status:'superseded' });
  ok('owning org edits a revision', r.status===200 && r.body.revision.status==='superseded');
  r = await call('PATCH', `/api/revisions/${revA}`, tok.b, { status:'draft' });
  ok('other org cannot edit a revision (403)', r.status===403);
  r = await call('PATCH', `/api/revisions/${revA}`, tok.con, { status:'approved' });
  ok('consultant can edit any revision', r.status===200);

  // ── evidence links a specific REVISION (same project only) ──
  let d = (await call('GET', `/api/projects/${p1}/duties`, tok.a)).body;
  const dutyId = d.duties[0].id;
  r = await call('POST', `/api/project-duties/${dutyId}/evidence`, tok.a, { revisionId: revB });
  ok('link a same-project revision as evidence', r.status===200);
  d = (await call('GET', `/api/projects/${p1}/duties`, tok.a)).body;
  const ev = d.duties.find(x=>x.id===dutyId).evidence;
  ok('evidence stores the revision link (ref + rev)', ev.length===1 && ev[0].revisionId===revB && ev[0].ref==='STR-CALC-001' && ev[0].rev==='Rev B');
  ok('duty now Awaiting AHS review', d.duties.find(x=>x.id===dutyId).status==='awaiting_review');

  r = await call('POST', `/api/project-duties/${dutyId}/evidence`, tok.a, { revisionId: revB });
  ok('cannot link the same revision twice (409)', r.status===409);

  // a revision from project 2 must not be linkable to a project 1 duty
  const doc2 = (await call('POST', `/api/projects/${p2}/documents`, tok.b, { name:'Other' })).body.document.id;
  const rev2 = (await call('POST', `/api/documents/${doc2}/revisions`, tok.b, { rev:'Rev A' })).body.revision.id;
  r = await call('POST', `/api/project-duties/${dutyId}/evidence`, tok.a, { revisionId: rev2 });
  ok('cannot link a revision from another project (400)', r.status===400);
  r = await call('POST', `/api/project-duties/${dutyId}/evidence`, tok.a, {});
  ok('revisionId required (400)', r.status===400);

  // delete a revision, then the reference (cascades)
  r = await call('DELETE', `/api/revisions/${revA}`, tok.b);
  ok('other org cannot delete a revision (403)', r.status===403);
  r = await call('DELETE', `/api/revisions/${revA}`, tok.a);
  ok('owning org deletes a revision', r.status===200);
  r = await call('DELETE', `/api/documents/${doc1}`, tok.a);
  ok('delete reference (cascades revisions)', r.status===200);
  r = await call('GET', `/api/projects/${p1}/documents`, tok.a);
  ok('library now empty', r.body?.documents?.length===0);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
