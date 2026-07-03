// ══════════════════════════════════════════════════════════════
//  /api/auth — login, logout, me
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { pool } = require('../db');
const {
  signSession, setSessionCookie, clearSessionCookie, requireAuth
} = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login  { email, password }
router.post('/login', async (req, res) => {
  const email    = String(req.body?.email||'').trim().toLowerCase();
  const password = String(req.body?.password||'');

  if(!email || !password){
    return res.status(400).json({ error: 'email_and_password_required' });
  }

  try {
    const r = await pool.query(
      `SELECT id, email, password_hash, tenant_id, role, display_name, is_active
         FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );
    if(!r.rows.length){
      // Same shape of response as wrong-password so attackers can't enumerate users
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const user = r.rows[0];
    const ok   = await bcrypt.compare(password, user.password_hash);
    if(!ok){
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // Deactivated accounts cannot sign in. Checked only after the password is
    // verified, so this never reveals account status to an unauthenticated guess.
    if(user.is_active === false){
      return res.status(403).json({ error: 'account_deactivated' });
    }

    // A suspended tenant's users cannot sign in either (Stage 6 Item 1) — this
    // matches the live-status guard so there is no login/redirect loop.
    if(user.tenant_id){
      const t = await pool.query(`SELECT status FROM tenants WHERE id = $1 LIMIT 1`, [user.tenant_id]);
      if(t.rows.length && t.rows[0].status === 'suspended'){
        return res.status(403).json({ error: 'tenant_suspended' });
      }
    }

    // Record login time (best-effort, don't block response)
    pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id])
      .catch(err => console.warn('Failed to update last_login_at:', err.message));

    const token = signSession(user);
    setSessionCookie(res, token);
    res.json({
      user: {
        id:       user.id,
        email:    user.email,
        role:     user.role,
        tenantId: user.tenant_id,
        name:     user.display_name
      }
    });
  } catch(err){
    console.error('Login error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// POST /api/auth/change-password — user changes their own password
// Requires the current password AND the new one (8+ chars).
router.post('/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword     = String(req.body?.newPassword || '');

  if(!newPassword || newPassword.length < 8){
    return res.status(400).json({ error: 'password_min_8' });
  }
  if(currentPassword === newPassword){
    return res.status(400).json({ error: 'password_unchanged' });
  }

  try {
    const r = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1 LIMIT 1`,
      [req.user.id]
    );
    if(!r.rows.length){
      return res.status(401).json({ error: 'user_not_found' });
    }
    const ok = await bcrypt.compare(currentPassword, r.rows[0].password_hash);
    if(!ok){
      return res.status(401).json({ error: 'current_password_wrong' });
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, req.user.id]);
    res.json({ ok: true });
  } catch(err){
    console.error('change-password error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/auth/me — returns current user (or 401 if not logged in)
router.get('/me', requireAuth, async (req, res) => {
  // Re-read from DB so we get the latest tenant + role (in case of recent changes)
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.tenant_id, u.role, u.display_name, u.is_active,
              t.name AS tenant_name, t.config AS tenant_config
         FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1 LIMIT 1`,
      [req.user.id]
    );
    if(!r.rows.length){
      clearSessionCookie(res);
      return res.status(401).json({ error: 'user_not_found' });
    }
    // If the account was deactivated since this session was issued, sign them out.
    if(r.rows[0].is_active === false){
      clearSessionCookie(res);
      return res.status(401).json({ error: 'account_deactivated' });
    }
    const u = r.rows[0];
    res.json({
      user: {
        id:         u.id,
        email:      u.email,
        role:       u.role,
        tenantId:   u.tenant_id,
        tenantName: u.tenant_name,
        config:     u.tenant_config || {},
        name:       u.display_name
      }
    });
  } catch(err){
    console.error('/me error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
