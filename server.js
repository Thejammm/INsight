// ══════════════════════════════════════════════════════════════
//  AHS InSight — server (Phase 0 scaffold)
//
//  For now this only serves the agreed prototype from public/ and a
//  health check, so the repo -> Coolify -> insight subdomain pipeline
//  is proven and the design is visible live. The Postgres-backed
//  framework, rules engine, accounts and AI review workflow are added
//  in the phased build (see REG_build_plan.md) — nothing here yet
//  reads or writes real data.
// ══════════════════════════════════════════════════════════════
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

// Trust the reverse proxy (Coolify/Traefik) so req.protocol / req.ip work.
app.set('trust proxy', 1);

// ── Health check ──────────────────────────────────────────────
// /healthz returns 200 while the process is up. A database check is
// added in Phase 1 once Postgres is wired in.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// No API surface yet — return 404 for any /api/* so nothing falls
// through to the SPA and looks like it worked.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ── Static front-end ──────────────────────────────────────────
// HTML is always revalidated so deploys are picked up immediately.
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

// SPA fallback — any other route serves index.html (also no-cache).
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`✓ AHS InSight listening on http://${HOST}:${PORT}`);
});
