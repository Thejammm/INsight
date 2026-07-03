// ══════════════════════════════════════════════════════════════
//  AHS InSight — server
//
//  - Serves the front-end from public/
//  - Postgres-backed per-tenant state
//  - Email/password auth with JWT in httpOnly cookie
//  - Bootstrap creates a consultant user on first run
// ══════════════════════════════════════════════════════════════
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');

const { migrate, isHealthy }   = require('./db');
const { bootstrap }            = require('./bootstrap');
const { seedDutyTemplates }    = require('./db/seedDuties');
const { seedGuidance }         = require('./db/seedGuidance');
const { seedStages }           = require('./db/seedStages');
const authRoutes               = require('./routes/auth');
const stateRoutes              = require('./routes/state');
const adminRoutes              = require('./routes/admin');
const projectRoutes            = require('./routes/projects').router;
const dutyTemplateRoutes       = require('./routes/dutyTemplates').router;
const projectDutyRoutes        = require('./routes/projectDuties').router;
const documentRoutes           = require('./routes/documents').router;
const deliverableRoutes        = require('./routes/deliverables').router;
const itpRoutes                = require('./routes/itp').router;
const ncrRoutes                = require('./routes/ncr').router;
const declarationRoutes        = require('./routes/declarations').router;

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

// Trust Render's proxy so req.protocol / req.ip work correctly
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────
app.use(cookieParser());

// JSON body parsing (state route overrides with a larger limit)
app.use(express.json({ limit: '1mb' }));

// ── Health check ──────────────────────────────────────────────
//   /healthz returns 200 if both the process AND the DB are reachable.
app.get('/healthz', async (_req, res) => {
  const dbOk = await isHealthy();
  if(!dbOk) return res.status(503).json({ ok: false, db: false });
  res.json({ ok: true, db: true, ts: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────
app.use('/api/auth',            authRoutes);
app.use('/api/state',           stateRoutes);
app.use('/api/admin',           adminRoutes);
app.use('/api/projects',        projectRoutes);
app.use('/api/duty-templates',  dutyTemplateRoutes);
app.use('/api/project-duties',  projectDutyRoutes);
app.use('/api',                 documentRoutes);   // /projects/:id/documents + /documents/:did
app.use('/api',                 deliverableRoutes); // /projects/:id/deliverables + /deliverables/:did
app.use('/api',                 itpRoutes);         // /projects/:id/itp + /itp/:iid
app.use('/api',                 ncrRoutes);         // /projects/:id/ncrs + /ncrs/:nid
app.use('/api',                 declarationRoutes); // /projects/:id/declarations + /declarations/:did

// 404 for any unknown /api/* path (don't fall through to the SPA)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ── Static front-end ──────────────────────────────────────────
// HTML is always revalidated so deploys are picked up immediately by the
// browser. Static assets (none yet, but future JS/CSS/images) still get
// short-cached so the page is fast.
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if(/\.html$/i.test(filePath)){
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

// SPA fallback — any other route serves index.html (also no-cache)
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Startup sequence ──────────────────────────────────────────
(async () => {
  try {
    await migrate();
    await bootstrap();
    await seedDutyTemplates();
    await seedGuidance();
    await seedStages();
    app.listen(PORT, HOST, () => {
      console.log(`✓ AHS InSight listening on http://${HOST}:${PORT}`);
    });
  } catch(err){
    console.error('FATAL: startup failed:', err);
    process.exit(1);
  }
})();
