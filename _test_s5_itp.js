// Round 2 Part A2 — ITP tiered verification + surveillance sampling + escalation.
// pg-mem, real JWTs. Run: node _test_s5_itp.js
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
  const { router: itpRouter } = require('./routes/itp');
  const { router: ncrRouter } = require('./routes/ncr');
  const { migrateQuality } = require('./db/migrateQuality');
  const { signSession } = require('./middleware/auth');

  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Vest Construction'),('org-b','Coolair Services')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@vest','h','org-a','client_user'),('u-b','b@coolair','h','org-b','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }),
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'Vest' }),
    b:   signSession({ id:'u-b', email:'b@coolair', role:'client_user', tenant_id:'org-b', display_name:'Coolair' }),
  };
  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/projects', projectsRouter); app.use('/api', itpRouter); app.use('/api', ncrRouter);
  const server = app.listen(0); const port = server.address().port;
  function call(m, p, t, b){ return new Promise(r => { const d=b?JSON.stringify(b):null; const rq=http.request({host:'127.0.0.1',port,path:p,method:m,headers:Object.assign({'Content-Type':'application/json'},t?{'Cookie':'ahs_session='+t}:{},d?{'Content-Length':Buffer.byteLength(d)}:{})},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{let j=null;try{j=JSON.parse(s);}catch(e){}r({status:x.statusCode,body:j});});});rq.on('error',()=>r({status:0}));if(d)rq.write(d);rq.end();}); }
  async function get(pid){ return (await call('GET', `/api/projects/${pid}/itp`, tok.con)).body.items; }

  let r = await call('POST', '/api/projects', tok.con, { name:'ITP Project', ribaStage:5 });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });

  // Migration: a legacy hold point + surveillance point map to tiers.
  await pool.query(`INSERT INTO itp_items (id,project_id,org_id,title,control_point,created_by,updated_by) VALUES
    ('leg-h',$1,'org-a','Legacy hold','hold','u-con','u-con'),('leg-s',$1,'org-a','Legacy surv','surveillance','u-con','u-con')`, [pid]);
  await migrateQuality();
  let items = await get(pid);
  ok('migration: hold -> hold tier', items.find(i=>i.id==='leg-h').tier === 'hold');
  ok('migration: non-hold -> witness tier', items.find(i=>i.id==='leg-s').tier === 'witness');

  // A surveillance line: population + target %.
  r = await call('POST', `/api/projects/${pid}/itp`, tok.con, { title:'Fire-stopping penetrations', section:'Fire', tier:'surveillance', orgId:'org-a', plannedStage:5, population:1240, targetPct:5 });
  const sid = r.body.item.id;
  items = await get(pid); let line = items.find(i=>i.id===sid);
  ok('surveillance line created with population + target', line.tier==='surveillance' && line.population===1240 && line.targetPct===5);

  // Benchmark-then-sample: a normal sample is refused until benchmark reviewed.
  r = await call('POST', `/api/itp/${sid}/samples`, tok.a, { result:'pass', ref:'P-001' });
  ok('sample refused before benchmark (409 benchmark_required)', r.status===409 && r.body.error==='benchmark_required');
  r = await call('POST', `/api/itp/${sid}/samples`, tok.a, { isBenchmark:true, result:'pass', ref:'Benchmark bay 1' });
  ok('benchmark sample added', r.status===200);
  r = await call('POST', `/api/itp/${sid}/samples`, tok.a, { result:'pass', ref:'P-002' });
  ok('sample still refused until benchmark REVIEWED', r.status===409);
  // find the benchmark sample id + approve it (consultant)
  line = (await get(pid)).find(i=>i.id===sid);
  const benchId = line.samples.find(s=>s.isBenchmark).id;
  r = await call('POST', `/api/itp/samples/${benchId}/review-benchmark`, tok.a);
  ok('client cannot approve the benchmark (403)', r.status===403);
  r = await call('POST', `/api/itp/samples/${benchId}/review-benchmark`, tok.con);
  ok('consultant approves the benchmark', r.status===200);
  r = await call('POST', `/api/itp/${sid}/samples`, tok.a, { result:'pass', ref:'P-002' });
  ok('samples allowed after benchmark approved', r.status===200);

  // Coverage tracking.
  for(let i=3;i<=20;i++) await call('POST', `/api/itp/${sid}/samples`, tok.a, { result:'pass', ref:'P-0'+i });
  line = (await get(pid)).find(i=>i.id===sid);
  ok('coverage tracks non-benchmark samples vs population', line.sampleCount===19 && line.coveragePct===Math.round(19/1240*100));

  // Escalation: 2 fails within the last 20 samples raises the target % + logs it.
  await call('POST', `/api/itp/${sid}/samples`, tok.a, { result:'fail', ref:'F-1' });
  r = await call('POST', `/api/itp/${sid}/samples`, tok.a, { result:'fail', ref:'F-2' });
  ok('escalation triggers on 2 fails in 20', r.body.escalated === true);
  line = (await get(pid)).find(i=>i.id===sid);
  ok('escalate flag set + target doubled (5 -> 10)', line.escalateFlag===true && Number(line.targetPct)===10);
  ok('an escalation audit note is recorded', line.escalationLog.some(e=>e.type==='escalate' && e.fails>=2));

  // De-escalation is consultant-only and restores the base target with an audit note.
  r = await call('POST', `/api/itp/${sid}/escalation/clear`, tok.a);
  ok('client cannot clear escalation (403)', r.status===403);
  r = await call('POST', `/api/itp/${sid}/escalation/clear`, tok.con);
  ok('consultant clears escalation', r.status===200);
  line = (await get(pid)).find(i=>i.id===sid);
  ok('cleared: flag off, target restored to base 5, clear logged', line.escalateFlag===false && Number(line.targetPct)===5 && line.escalationLog.some(e=>e.type==='clear'));

  // NCR linked to the line is counted in the assurance figures.
  await call('POST', `/api/projects/${pid}/ncrs`, tok.con, { title:'Penetration F-1 non-conforming', severity:'minor', itpItemId:sid });
  line = (await get(pid)).find(i=>i.id===sid);
  ok('linked NCR counted on the line', line.ncrOpen===1);
  ok('assurance summary sentence present', /Surveillance — population 1240/.test(line.assurance) && /target/.test(line.assurance));

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
