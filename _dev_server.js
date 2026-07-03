// Local dev server for building/testing the front-end against a REAL backend
// without Postgres: uses pg-mem in-process, serves public/ + all the real API
// routes on http://localhost:8801 (same-origin, so the auth cookie works).
// Seeds a consultant + a couple of organisations + one project so there is data
// to see immediately. NOT for production. Run via the `insight-dev` launch config.
process.env.SESSION_SECRET = 'dev-secret-at-least-32-chars-long-000000';
process.env.NODE_ENV = 'development';   // cookie not Secure -> works over http localhost

const fs = require('fs'), path = require('path'), crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { newDb } = require('pg-mem');

const db = newDb({ autoCreateForeignKeyIndices: true });
fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8')
  .split(/;\s*(?:\r?\n|$)/).map(s => s.replace(/^\s*(?:--[^\n]*\n)+/gm, '').trim()).filter(Boolean)
  .forEach(s => { try { db.public.none(s); } catch(e){} });
const { Pool } = db.adapters.createPg();
const pool = new Pool();

// Inject the pg-mem pool as ./db before any route/module loads it.
require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'), filename: require.resolve('./db'), loaded: true,
  exports: { pool, migrate: async () => {}, isHealthy: async () => true },
};

const { seedDutyTemplates } = require('./db/seedDuties');
const { seedGuidance } = require('./db/seedGuidance');
const { seedStages } = require('./db/seedStages');

(async () => {
  await seedDutyTemplates();
  await seedGuidance();   // dev-only: production seed waits for Simon's sign-off
  await seedStages();
  const hash = await bcrypt.hash('devpass123', 10);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role,display_name) VALUES ($1,$2,$3,NULL,'consultant',$4)`,
    ['u-con', 'simon@dev', hash, 'Simon Archer (AHS)']);
  const chash = await bcrypt.hash('devpass123', 10);
  await pool.query(`INSERT INTO tenants (id,name) VALUES ('ncg','Newcastle College Group'),('vest','Vest Construction'),('fineline','Fineline Architectural')`);
  await pool.query(`INSERT INTO users (id,email,password_hash,tenant_id,role,display_name) VALUES ($1,$2,$3,'vest','client_user',$4)`,
    ['u-vest', 'vest@dev', chash, 'Vest User']);

  // One demo project with an appointment (15 PC duties) so the loop is visible.
  const pid = crypto.randomUUID();
  await pool.query(`INSERT INTO projects (id,name,ref,riba_stage,created_by) VALUES ($1,'Engineering block refurbishment','2026018',5,'u-con')`, [pid]);
  const aid = crypto.randomUUID();
  await pool.query(`INSERT INTO appointments (id,project_id,org_id,role,appointed_by) VALUES ($1,$2,'vest','principal_contractor','u-con')`, [aid, pid]);
  const tpl = await pool.query(`SELECT id,seq,duty,citation FROM duty_templates WHERE role='principal_contractor' AND is_active=TRUE ORDER BY seq`);
  for(const d of tpl.rows){
    await pool.query(`INSERT INTO project_duties (id,project_id,appointment_id,role,duty_template_id,seq,duty,citation,created_by,updated_by) VALUES ($1,$2,$3,'principal_contractor',$4,$5,$6,$7,'u-con','u-con')`,
      [crypto.randomUUID(), pid, aid, d.id, d.seq, d.duty, d.citation]);
  }

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  app.get('/healthz', (_r, s) => s.json({ ok: true, dev: true }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/state', require('./routes/state'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/projects', require('./routes/projects').router);
  app.use('/api/duty-templates', require('./routes/dutyTemplates').router);
  app.use('/api/project-duties', require('./routes/projectDuties').router);
  app.use('/api', require('./routes/documents').router);
  app.use('/api', require('./routes/deliverables').router);
  app.use('/api', (_r, s) => s.status(404).json({ error: 'not_found' }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], setHeaders: (res, fp) => { if(/\.html$/i.test(fp)) res.setHeader('Cache-Control','no-cache'); } }));
  app.get('*', (_r, s) => s.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.listen(8801, () => console.log('✓ InSight DEV (pg-mem) on http://localhost:8801  — login simon@dev / devpass123'));
})().catch(e => { console.error('dev server failed:', e); process.exit(1); });
