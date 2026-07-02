// Local test for Stage 4 Item 3 — duty templates seed + API. pg-mem in-memory
// Postgres (no local PG), real JWTs, real routes over HTTP. Run: node _test_item3.js
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
    .forEach(s => { try { db.public.none(s); } catch(e){ /* pg-mem can't run functional indexes / some ALTERs; irrelevant here */ } });

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const dbPath = require.resolve('./db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };

  const { seedDutyTemplates, DUTY_TEMPLATES } = require('./db/seedDuties');
  const { router } = require('./routes/dutyTemplates');
  const { signSession } = require('./middleware/auth');

  // seed — call with NO args, exactly as server.js does (the module gets its
  // own pool from ./index; the require.cache mock above supplies the pg-mem one)
  await seedDutyTemplates();
  const cnt = await pool.query('SELECT COUNT(*) AS n FROM duty_templates');
  ok('seed inserts 50 duty templates', Number(cnt.rows[0].n) === 50);

  const byRole = await pool.query('SELECT role, COUNT(*) AS n FROM duty_templates GROUP BY role');
  const rc = {}; byRole.rows.forEach(r => rc[r.role] = Number(r.n));
  ok('role counts correct', rc.client===10 && rc.designer===5 && rc.principal_designer===8 &&
     rc.principal_contractor===15 && rc.contractor===5 && rc.br_principal_designer===5 && rc.br_principal_contractor===2);

  // every duty has a non-empty citation (never ship a blank/invented one)
  const blank = await pool.query(`SELECT COUNT(*) AS n FROM duty_templates WHERE citation IS NULL OR citation = ''`);
  ok('every duty has a citation', Number(blank.rows[0].n) === 0 && DUTY_TEMPLATES.every(d => d.citation && d.citation.trim()));

  // seed is idempotent
  await seedDutyTemplates(pool);
  const cnt2 = await pool.query('SELECT COUNT(*) AS n FROM duty_templates');
  ok('re-running the seed does not duplicate', Number(cnt2.rows[0].n) === 50);

  // seed data matches the verified citations set (CDM 2015 + Building Regs Part 2A)
  const cites = new Set(DUTY_TEMPLATES.map(d => d.citation));
  ok('Building Regs Part 2A citation present', cites.has('Building Regulations 2010, Part 2A'));
  ok('CDM Reg 4 + Part 4 + Sch 2 citations present', cites.has('CDM 2015, Reg 4') && cites.has('CDM 2015, Part 4') && cites.has('CDM 2015, Sch 2'));

  // users + tokens
  await pool.query(`INSERT INTO tenants (id,name) VALUES ('org-a','Vest Construction')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role) VALUES
    ('u-con','con@ahs','h',NULL,'consultant'),('u-a','a@vest','h','org-a','client_user')`);
  const tok = {
    con: signSession({ id:'u-con', email:'con@ahs', role:'consultant', tenant_id:null }),
    a:   signSession({ id:'u-a', email:'a@vest', role:'client_user', tenant_id:'org-a' }),
  };

  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/duty-templates', router);
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

  // any signed-in user can read; ordered by role then seq
  let r = await call('GET', '/api/duty-templates', tok.a);
  ok('client user can read all templates (50)', r.status===200 && r.body?.dutyTemplates?.length===50);

  r = await call('GET', '/api/duty-templates?role=principal_contractor', tok.a);
  ok('role filter returns PC duties (15)', r.status===200 && r.body?.dutyTemplates?.length===15 &&
     r.body.dutyTemplates.every(d => d.role==='principal_contractor'));
  ok('role filter is ordered by seq', r.body.dutyTemplates.map(d=>d.seq).join(',') === Array.from({length:15},(_,i)=>i+1).join(','));

  // client user cannot write
  r = await call('POST', '/api/duty-templates', tok.a, { role:'client', duty:'x', citation:'y' });
  ok('client user cannot add a duty (403)', r.status===403);

  // consultant edits a duty (wording change)
  const pcOne = (await call('GET','/api/duty-templates?role=client', tok.con)).body.dutyTemplates[0];
  r = await call('PATCH', `/api/duty-templates/${pcOne.id}`, tok.con, { duty: pcOne.duty + ' (amended)' });
  ok('consultant can edit a duty', r.status===200 && /\(amended\)$/.test(r.body?.dutyTemplate?.duty));

  // consultant retires a duty -> disappears from default list, count drops by 1
  r = await call('DELETE', `/api/duty-templates/${pcOne.id}`, tok.con);
  ok('consultant can retire a duty (soft)', r.status===200 && r.body?.ok===true);
  r = await call('GET', '/api/duty-templates', tok.con);
  ok('retired duty hidden from default list (49)', r.body?.dutyTemplates?.length===49);
  r = await call('GET', '/api/duty-templates?all=1', tok.con);
  ok('consultant can still see retired with all=1 (50)', r.body?.dutyTemplates?.length===50);

  // invalid role / blank citation rejected
  r = await call('POST', '/api/duty-templates', tok.con, { role:'wizard', duty:'x', citation:'y' });
  ok('invalid role rejected (400)', r.status===400);
  r = await call('POST', '/api/duty-templates', tok.con, { role:'client', duty:'x', citation:'' });
  ok('blank citation rejected (400)', r.status===400);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
