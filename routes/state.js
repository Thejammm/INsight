// ══════════════════════════════════════════════════════════════
//  /api/state — per-tenant state load and save
//
//  Every state read/write is scoped to req.user.tenantId.
//  Consultants without a tenant_id need to pick a tenant via
//  ?tenantId=xxx query param (admin UI in Phase B+).
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Resolve which tenant the request is acting on.
// - client_user: always their own tenant_id, ignores query.
// - consultant: must pass ?tenantId=... (or it'd be ambiguous).
function _resolveTenant(req){
  if(req.user.role === 'client_user'){
    return req.user.tenantId || null;
  }
  // consultant
  return (req.query?.tenantId || req.body?.tenantId || '').toString() || null;
}

// GET /api/state[?tenantId=xxx]  (tenantId required for consultants)
router.get('/', requireAuth, async (req, res) => {
  const tenantId = _resolveTenant(req);
  if(!tenantId){
    return res.status(400).json({ error: 'tenant_required' });
  }
  try {
    const r = await pool.query(
      `SELECT state, updated_at FROM app_state WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );
    if(!r.rows.length){
      // No state yet — return empty state so frontend can seed it
      return res.json({ tenantId, state: null, updatedAt: null });
    }
    res.json({
      tenantId,
      state:     r.rows[0].state,
      updatedAt: r.rows[0].updated_at
    });
  } catch(err){
    console.error('GET /api/state error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/state  body: { state: {...}, tenantId?: 'xxx' }
router.post('/', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
  const tenantId = _resolveTenant(req);
  if(!tenantId){
    return res.status(400).json({ error: 'tenant_required' });
  }
  const state = req.body?.state;
  if(!state || typeof state !== 'object'){
    return res.status(400).json({ error: 'state_object_required' });
  }
  try {
    // Verify the tenant exists (and the user is allowed to write to it)
    const t = await pool.query(`SELECT 1 FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
    if(!t.rows.length){
      return res.status(404).json({ error: 'tenant_not_found' });
    }
    if(req.user.role === 'client_user' && req.user.tenantId !== tenantId){
      return res.status(403).json({ error: 'forbidden' });
    }

    const r = await pool.query(
      `INSERT INTO app_state (tenant_id, state, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (tenant_id) DO UPDATE
         SET state = EXCLUDED.state,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [tenantId, JSON.stringify(state), req.user.id]
    );
    res.json({
      ok:        true,
      tenantId,
      updatedAt: r.rows[0].updated_at
    });
  } catch(err){
    console.error('POST /api/state error:', err);
    if(err.code === '54000' || /size/i.test(err.message)){
      return res.status(413).json({ error: 'state_too_large' });
    }
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
