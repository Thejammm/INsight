// Local test for Stage 4 Items 6 (RIBA spine) + 7 (project dashboard). pg-mem,
// real JWTs, real routes over HTTP. Run: node _test_item6_7.js
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
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'Vest User' }),
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

  let r = await call('POST', '/api/projects', tok.con, { name:'Engineering block refurbishment' });
  const proj = r.body.project.id;
  await call('POST', `/api/projects/${proj}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });

  // ── RIBA spine ──
  r = await call('GET', `/api/projects/${proj}/riba`, tok.a);
  ok('RIBA returns 8 stages', r.status===200 && r.body?.stages?.length===8);
  ok('stages carry names + CDM narrative', r.body.stages[5].name==='Manufacturing and Construction' && /Part 4/.test(r.body.stages[5].cdm));
  ok('no current stage until set', r.body.currentStage === null);

  r = await call('PATCH', `/api/projects/${proj}/riba`, tok.a, { currentStage:5 });
  ok('client cannot set RIBA stage (403)', r.status===403);
  r = await call('PATCH', `/api/projects/${proj}/riba`, tok.con, { currentStage:5, dates:{ '5':'12 Jul 2026' } });
  ok('consultant sets current stage + date', r.status===200 && r.body?.currentStage===5);
  r = await call('GET', `/api/projects/${proj}/riba`, tok.a);
  ok('stage 5 is current, 4 done, 6 upcoming', r.body.stages[5].state==='current' && r.body.stages[4].state==='done' && r.body.stages[6].state==='upcoming');
  ok('per-stage date returned', r.body.stages[5].date==='12 Jul 2026');

  // ── dashboard ──
  const duties = (await call('GET', `/api/projects/${proj}/duties`, tok.a)).body.duties;
  const addDocAndLink = async (dutyId) => {
    const doc = (await call('POST', `/api/projects/${proj}/documents`, tok.a, { name:'ev-'+dutyId })).body.document.id;
    await call('POST', `/api/project-duties/${dutyId}/evidence`, tok.a, { documentId: doc });
  };
  // duty0 -> reviewed; duty1 -> returned; duty2 -> awaiting; duty3 -> evidence_outstanding
  await addDocAndLink(duties[0].id); await call('POST', `/api/project-duties/${duties[0].id}/review`, tok.con, { action:'reviewed' });
  await call('POST', `/api/project-duties/${duties[1].id}/review`, tok.con, { action:'returned', note:'Add the design check.' });
  await addDocAndLink(duties[2].id);
  await call('PATCH', `/api/project-duties/${duties[3].id}`, tok.a, { discharge:'Recorded in the CPP.' });

  r = await call('GET', `/api/projects/${proj}/dashboard`, tok.a);
  const s = r.body.stats;
  ok('dashboard totals correct', s.total===15 && s.reviewed===1 && s.returned===1 && s.awaiting===1 && s.evidenceOutstanding===1 && s.outstanding===11);
  ok('not started = 12, compliance = 7%, RAG red', s.notStarted===12 && s.compliancePct===7 && s.rag==='red');
  ok('outstanding list excludes the reviewed one (14)', r.body.outstanding.length===14);
  ok('outstanding is ordered returned-first', r.body.outstanding[0].status==='returned' && r.body.outstanding[1].status==='awaiting_review');

  // ── cross-project roll-up on the list ──
  r = await call('GET', '/api/projects', tok.con);
  const pj = r.body.projects.find(x => x.id===proj);
  ok('project list carries a compliance summary', pj?.summary?.total===15 && pj.summary.reviewed===1 && pj.summary.compliancePct===7);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
