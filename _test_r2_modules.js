// Round 2 Part B — per-project module switches. pg-mem, real JWTs.
// Run: node _test_r2_modules.js
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
  const { router: delRouter } = require('./routes/deliverables');
  const { signSession } = require('./middleware/auth');
  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Vest Construction')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@vest','h','org-a','client_user')`);
  const tok = { con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null, display_name:'AHS' }), a: signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a', display_name:'Vest' }) };
  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/projects', projectsRouter); app.use('/api', delRouter);
  const server = app.listen(0); const port = server.address().port;
  function call(m, p, t, b){ return new Promise(r => { const d=b?JSON.stringify(b):null; const rq=http.request({host:'127.0.0.1',port,path:p,method:m,headers:Object.assign({'Content-Type':'application/json'},t?{'Cookie':'ahs_session='+t}:{},d?{'Content-Length':Buffer.byteLength(d)}:{})},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{let j=null;try{j=JSON.parse(s);}catch(e){}r({status:x.statusCode,body:j});});});rq.on('error',()=>r({status:0}));if(d)rq.write(d);rq.end();}); }

  let r = await call('POST', '/api/projects', tok.con, { name:'Modules Project' });
  const pid = r.body.project.id;
  await call('POST', `/api/projects/${pid}/appointments`, tok.con, { orgId:'org-a', role:'principal_contractor' });

  r = await call('GET', `/api/projects/${pid}`, tok.con);
  ok('default: all modules on', r.body.project.modules.design===true && r.body.project.modules.construction===true && r.body.project.modules.dutyholder===true);

  r = await call('PATCH', `/api/projects/${pid}/modules`, tok.a, { design:false });
  ok('client cannot toggle modules (403)', r.status === 403);

  r = await call('PATCH', `/api/projects/${pid}/modules`, tok.con, { design:false });
  ok('consultant switches design off', r.status===200 && r.body.modules.design===false && r.body.modules.construction===true);
  r = await call('GET', `/api/projects/${pid}`, tok.con);
  ok('design off persists', r.body.project.modules.design===false);
  ok('an audit note is written (who/when/module/on)', Array.isArray(r.body.project.module_log) && r.body.project.module_log.some(e=>e.module==='design' && e.on===false && e.by));

  r = await call('PATCH', `/api/projects/${pid}/modules`, tok.con, { construction:false });
  r = await call('GET', `/api/projects/${pid}`, tok.con);
  ok('both quality modules off; dutyholder still forced on', r.body.project.modules.design===false && r.body.project.modules.construction===false && r.body.project.modules.dutyholder===true);

  // Data is retained while off: add a deliverable via SQL then toggle back on.
  await pool.query(`INSERT INTO design_deliverables (id,project_id,org_id,title,gate_status,created_by,updated_by) VALUES ('d1',$1,'org-a','Kept deliverable','not_submitted','u-con','u-con')`, [pid]);
  r = await call('PATCH', `/api/projects/${pid}/modules`, tok.con, { design:true });
  ok('design switched back on', r.body.modules.design===true);
  r = await call('GET', `/api/projects/${pid}/deliverables`, tok.con);
  ok('data retained through off/on cycle', r.body.deliverables.length===1 && r.body.deliverables[0].title==='Kept deliverable');

  // Toggling the same value again writes no new audit entry (idempotent).
  r = await call('GET', `/api/projects/${pid}`, tok.con); const before = r.body.project.module_log.length;
  await call('PATCH', `/api/projects/${pid}/modules`, tok.con, { design:true });
  r = await call('GET', `/api/projects/${pid}`, tok.con);
  ok('no-op toggle writes no audit entry', r.body.project.module_log.length === before);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
