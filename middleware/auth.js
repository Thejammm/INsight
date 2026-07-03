// ══════════════════════════════════════════════════════════════
//  Authentication middleware
//  Verifies the JWT in the 'ahs_session' cookie. Sets req.user.
// ══════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'ahs_session';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  path: '/'
};

function _getSecret(){
  const s = process.env.SESSION_SECRET;
  if(!s || s.length < 32){
    throw new Error('SESSION_SECRET env var must be set and at least 32 characters');
  }
  return s;
}

function signSession(user){
  // Keep the payload small — only what we'll check on each request
  const payload = {
    sub:      user.id,
    email:    user.email,
    role:     user.role,
    tenantId: user.tenant_id || null,
    name:     user.display_name || null
  };
  return jwt.sign(payload, _getSecret(), { expiresIn: '30d' });
}

function setSessionCookie(res, token){
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

function clearSessionCookie(res){
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Middleware: require an authenticated user. Sets req.user on success.
function requireAuth(req, res, next){
  const token = req.cookies?.[COOKIE_NAME];
  if(!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    const payload = jwt.verify(token, _getSecret());
    req.user = {
      id:       payload.sub,
      email:    payload.email,
      role:     payload.role,
      tenantId: payload.tenantId || null,
      name:     payload.name || null
    };
    next();
  } catch(e){
    return res.status(401).json({ error: 'invalid_session' });
  }
}

// Middleware: require the user to be a consultant.
function requireConsultant(req, res, next){
  if(req.user?.role !== 'consultant'){
    return res.status(403).json({ error: 'consultant_only' });
  }
  next();
}

// Middleware: live account + tenant status check (Stage 6 Item 1).
// The JWT is valid for 30 days, so a deactivated user or suspended tenant would
// otherwise keep access until it expires. This re-checks the database on each
// request that carries a session, so a change takes effect immediately. It does
// NOT enforce authentication (that is requireAuth's job) — with no/invalid
// cookie it passes through so protected routes still 401 as normal. Never
// hard-fails the app on a transient DB hiccup.
async function requireLiveStatus(req, res, next){
  const token = req.cookies?.[COOKIE_NAME];
  if(!token) return next();
  let payload;
  try { payload = jwt.verify(token, _getSecret()); } catch(e){ return next(); }
  try {
    const { pool } = require('../db');
    const u = await pool.query('SELECT is_active, tenant_id FROM users WHERE id = $1 LIMIT 1', [payload.sub]);
    if(!u.rows.length || u.rows[0].is_active === false){
      clearSessionCookie(res);
      return res.status(401).json({ error: 'account_deactivated' });
    }
    const tid = u.rows[0].tenant_id;
    if(tid){
      const t = await pool.query('SELECT status FROM tenants WHERE id = $1 LIMIT 1', [tid]);
      if(t.rows.length && t.rows[0].status === 'suspended'){
        return res.status(403).json({ error: 'tenant_suspended' });
      }
    }
    next();
  } catch(e){
    next();   // status check should never take the whole API down
  }
}

module.exports = {
  COOKIE_NAME,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireConsultant,
  requireLiveStatus
};
