// ══════════════════════════════════════════════════════════════
//  /api/admin — consultant-only endpoints to manage tenants + users
//
//  Used by you (the consultant) to:
//    - Create a new tenant (client business)
//    - Create a new user (assign to a tenant)
//    - List tenants and users
//    - Reset a user's password
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireConsultant } = require('../middleware/auth');

const router = express.Router();

// All admin routes require an authenticated consultant
router.use(requireAuth, requireConsultant);

// Whitelist + shape the tenant config so only known client-configuration fields
// are stored (icon, location, default inspection type, pack, branding). Anything
// else the client sends is dropped. Returns a plain object (never null/array).
function _cleanConfig(input){
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const out = {};
  const str = v => (v === undefined || v === null) ? undefined : String(v);
  if(str(src.icon)     !== undefined) out.icon     = str(src.icon).slice(0, 8);
  if(str(src.location) !== undefined) out.location = str(src.location).slice(0, 200);
  if(str(src.inspType) !== undefined) out.inspType = str(src.inspType).slice(0, 60);
  if(str(src.checklist)!== undefined) out.checklist= str(src.checklist).slice(0, 60);
  // Near Miss notify recipient (per-tenant; replaces the old hardcoded address).
  if(str(src.notifyEmail) !== undefined) out.notifyEmail = str(src.notifyEmail).trim().slice(0, 200);
  // Inspection packs this tenant sees (garage/construction). Empty = show all.
  if(Array.isArray(src.packs)){
    const allowed = ['garage','construction'];
    out.packs = [...new Set(src.packs.map(x => String(x)).filter(x => allowed.includes(x)))];
  }
  if(src.branding && typeof src.branding === 'object' && !Array.isArray(src.branding)){
    const b = {};
    ['primary','accent','textColor'].forEach(k => {
      if(str(src.branding[k]) !== undefined) b[k] = str(src.branding[k]).slice(0, 32);
    });
    if(Object.keys(b).length) out.branding = b;
  }
  return out;
}

// ── Tenants ─────────────────────────────────────────────────────

// GET /api/admin/tenants — list all tenants
router.get('/tenants', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id, t.name, t.config, t.status, t.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
              (SELECT updated_at FROM app_state s WHERE s.tenant_id = t.id) AS last_state_update
         FROM tenants t
         ORDER BY t.created_at DESC`
    );
    res.json({ tenants: r.rows });
  } catch(err){
    console.error('GET /tenants error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/tenants  body: { id?: 'easy-travel', name: 'Easy Travel Leeds' }
router.post('/tenants', async (req, res) => {
  const name = String(req.body?.name||'').trim();
  if(!name){ return res.status(400).json({ error: 'name_required' }); }
  let id = String(req.body?.id||'').trim().toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-|-$/g,'');
  if(!id){
    id = name.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-|-$/g,'').slice(0, 50) || ('tenant-'+Date.now());
  }
  const config = _cleanConfig(req.body?.config);
  try {
    await pool.query(
      `INSERT INTO tenants (id, name, config) VALUES ($1, $2, $3::jsonb)`,
      [id, name, JSON.stringify(config)]
    );
    res.json({ tenant: { id, name, config } });
  } catch(err){
    if(err.code === '23505'){
      return res.status(409).json({ error: 'tenant_id_exists' });
    }
    console.error('POST /tenants error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/admin/tenants/:id  body: { name?, config? }
// Updates the display name and/or the client config. id is immutable. Any field
// left out is kept as-is; config is merged over the current config so a partial
// edit (e.g. just branding) doesn't wipe the rest.
router.patch('/tenants/:id', async (req, res) => {
  const id = req.params.id;
  const hasName   = req.body?.name   !== undefined;
  const hasConfig = req.body?.config !== undefined;
  const hasStatus = req.body?.status !== undefined;
  if(!hasName && !hasConfig && !hasStatus){ return res.status(400).json({ error: 'nothing_to_update' }); }
  const name = hasName ? String(req.body.name||'').trim() : null;
  if(hasName && !name){ return res.status(400).json({ error: 'name_required' }); }
  let status = null;
  if(hasStatus){
    status = String(req.body.status);
    if(!['active','suspended'].includes(status)){ return res.status(400).json({ error: 'invalid_status' }); }
  }
  try {
    const cur = await pool.query(`SELECT name, config, status FROM tenants WHERE id = $1 LIMIT 1`, [id]);
    if(!cur.rows.length){ return res.status(404).json({ error: 'tenant_not_found' }); }

    const newName   = hasName ? name : cur.rows[0].name;
    const curConfig = (cur.rows[0].config && typeof cur.rows[0].config === 'object') ? cur.rows[0].config : {};
    const newConfig = hasConfig ? { ...curConfig, ..._cleanConfig(req.body.config) } : curConfig;
    const newStatus = hasStatus ? status : (cur.rows[0].status || 'active');

    await pool.query(
      `UPDATE tenants SET name = $1, config = $2::jsonb, status = $3 WHERE id = $4`,
      [newName, JSON.stringify(newConfig), newStatus, id]
    );
    res.json({ ok: true, tenant: { id, name: newName, config: newConfig, status: newStatus } });
  } catch(err){
    console.error('PATCH /tenants/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/admin/tenants/:id — fails if any users still belong to it
router.delete('/tenants/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const u = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1`, [id]);
    if(u.rows[0].n > 0){
      return res.status(409).json({ error: 'tenant_has_users', count: u.rows[0].n });
    }
    // Cascade-delete the tenant's saved app_state if any
    await pool.query(`DELETE FROM app_state WHERE tenant_id = $1`, [id]);
    const r = await pool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    if(r.rowCount === 0){ return res.status(404).json({ error: 'tenant_not_found' }); }
    res.json({ ok: true });
  } catch(err){
    console.error('DELETE /tenants/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Users ───────────────────────────────────────────────────────

// GET /api/admin/users — list all users
router.get('/users', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.role, u.tenant_id, u.display_name,
              u.created_at, u.last_login_at, u.is_active, u.password_plain,
              t.name AS tenant_name
         FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id
         ORDER BY u.created_at DESC`
    );
    res.json({ users: r.rows });
  } catch(err){
    console.error('GET /users error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/users
//   body: { email, password, role: 'consultant'|'client_user', tenantId?, displayName? }
router.post('/users', async (req, res) => {
  const email       = String(req.body?.email||'').trim().toLowerCase();
  const password    = String(req.body?.password||'');
  const role        = String(req.body?.role||'').trim();
  const tenantId    = req.body?.tenantId ? String(req.body.tenantId).trim() : null;
  const displayName = req.body?.displayName ? String(req.body.displayName).trim() : null;

  if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){
    return res.status(400).json({ error: 'valid_email_required' });
  }
  if(!password || password.length < 8){
    return res.status(400).json({ error: 'password_min_8' });
  }
  if(!['consultant','client_user'].includes(role)){
    return res.status(400).json({ error: 'invalid_role' });
  }
  if(role === 'client_user' && !tenantId){
    return res.status(400).json({ error: 'tenant_required_for_client_user' });
  }

  try {
    if(tenantId){
      const t = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
      if(!t.rows.length){ return res.status(404).json({ error: 'tenant_not_found' }); }
    }

    const id   = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (id, email, password_hash, tenant_id, role, display_name, password_plain)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, email, hash, tenantId, role, displayName, password]
    );
    res.json({ user: { id, email, role, tenantId, displayName } });
  } catch(err){
    if(err.code === '23505'){
      return res.status(409).json({ error: 'email_exists' });
    }
    console.error('POST /users error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/users/:id/reset-password  body: { password }
router.post('/users/:id/reset-password', async (req, res) => {
  const id       = req.params.id;
  const password = String(req.body?.password||'');
  if(!password || password.length < 8){
    return res.status(400).json({ error: 'password_min_8' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `UPDATE users SET password_hash = $1, password_plain = $2 WHERE id = $3`,
      [hash, password, id]
    );
    if(r.rowCount === 0){ return res.status(404).json({ error: 'user_not_found' }); }
    res.json({ ok: true });
  } catch(err){
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/admin/users/:id/active  body: { active: true|false }
// Soft enable/disable a login. A deactivated user can no longer sign in, but
// their record — and the inspection history under their tenant — is preserved.
// We deactivate rather than hard-delete so nothing is ever lost and it is
// fully reversible. Refuses to deactivate the currently signed-in user (would
// otherwise lock them out of the admin panel).
router.patch('/users/:id/active', async (req, res) => {
  const id = req.params.id;
  if(typeof req.body?.active !== 'boolean'){
    return res.status(400).json({ error: 'active_boolean_required' });
  }
  const active = req.body.active;
  if(!active && req.user && String(req.user.id) === String(id)){
    return res.status(400).json({ error: 'cannot_deactivate_self' });
  }
  try {
    const r = await pool.query(
      `UPDATE users SET is_active = $1 WHERE id = $2`,
      [active, id]
    );
    if(r.rowCount === 0){ return res.status(404).json({ error: 'user_not_found' }); }
    res.json({ ok: true, id, is_active: active });
  } catch(err){
    console.error('PATCH /users/:id/active error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/admin/users/:id — edit a user in full: email, display name,
// role, tenant, and (optionally) a new password. Any field left out is kept
// as-is. Login still verifies against password_hash; password_plain is updated
// alongside so the consultant can read it back.
router.patch('/users/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const cur = await pool.query(
      `SELECT id, email, role, tenant_id, display_name FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );
    if(!cur.rows.length){ return res.status(404).json({ error: 'user_not_found' }); }
    const u = cur.rows[0];

    // Merge incoming values over the current ones (only provided fields change)
    const email = req.body?.email !== undefined
      ? String(req.body.email).trim().toLowerCase() : u.email;
    const displayName = req.body?.displayName !== undefined
      ? (String(req.body.displayName).trim() || null) : u.display_name;
    const role = req.body?.role !== undefined ? String(req.body.role).trim() : u.role;
    let tenantId = req.body?.tenantId !== undefined
      ? (req.body.tenantId ? String(req.body.tenantId).trim() : null) : u.tenant_id;
    const password = req.body?.password !== undefined ? String(req.body.password) : null;

    if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){
      return res.status(400).json({ error: 'valid_email_required' });
    }
    if(!['consultant','client_user'].includes(role)){
      return res.status(400).json({ error: 'invalid_role' });
    }
    if(role === 'consultant'){ tenantId = null; }
    if(role === 'client_user' && !tenantId){
      return res.status(400).json({ error: 'tenant_required_for_client_user' });
    }
    // Don't let the signed-in consultant demote themselves out of admin access
    if(String(req.user.id) === String(id) && role !== 'consultant'){
      return res.status(400).json({ error: 'cannot_demote_self' });
    }
    if(password !== null && password.length < 8){
      return res.status(400).json({ error: 'password_min_8' });
    }
    if(tenantId){
      const t = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
      if(!t.rows.length){ return res.status(404).json({ error: 'tenant_not_found' }); }
    }

    if(password !== null){
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE users SET email = $1, display_name = $2, role = $3, tenant_id = $4,
                          password_hash = $5, password_plain = $6
           WHERE id = $7`,
        [email, displayName, role, tenantId, hash, password, id]
      );
    } else {
      await pool.query(
        `UPDATE users SET email = $1, display_name = $2, role = $3, tenant_id = $4
           WHERE id = $5`,
        [email, displayName, role, tenantId, id]
      );
    }
    res.json({ ok: true, user: { id, email, role, tenantId, displayName } });
  } catch(err){
    if(err.code === '23505'){ return res.status(409).json({ error: 'email_exists' }); }
    console.error('PATCH /users/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/admin/users/:id — hard delete a login. Used by the admin panel's
// "Delete company and all data" flow (remove every login, then the company).
// Refuses to delete the signed-in consultant. app_state.updated_by is ON DELETE
// SET NULL so history rows survive.
router.delete('/users/:id', async (req, res) => {
  const id = req.params.id;
  if(String(req.user.id) === String(id)){
    return res.status(400).json({ error: 'cannot_delete_self' });
  }
  try {
    const r = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    if(r.rowCount === 0){ return res.status(404).json({ error: 'user_not_found' }); }
    res.json({ ok: true });
  } catch(err){
    console.error('DELETE /users/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
