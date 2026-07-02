// ══════════════════════════════════════════════════════════════
//  Bootstrap — one-time setup tasks run on server startup.
//
//  Creates the first consultant user from ADMIN_EMAIL and
//  ADMIN_PASSWORD env vars if no consultants exist yet.
//  After first run, you can (and should) change the password
//  via the app and remove ADMIN_PASSWORD from Render env vars.
// ══════════════════════════════════════════════════════════════
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const { pool } = require('./db');

async function bootstrap(){
  const adminEmail    = (process.env.ADMIN_EMAIL    || '').trim().toLowerCase();
  const adminPassword =  process.env.ADMIN_PASSWORD || '';
  const adminName     = (process.env.ADMIN_NAME     || '').trim();

  if(!adminEmail || !adminPassword){
    console.log('• Bootstrap skipped: ADMIN_EMAIL / ADMIN_PASSWORD not set');
    return;
  }

  // Has any consultant already been created?
  const existing = await pool.query(
    `SELECT id FROM users WHERE role = 'consultant' LIMIT 1`
  );
  if(existing.rows.length){
    console.log('• Bootstrap skipped: a consultant already exists');
    return;
  }

  // Validate inputs
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)){
    console.warn('• Bootstrap skipped: ADMIN_EMAIL is not a valid email');
    return;
  }
  if(adminPassword.length < 8){
    console.warn('• Bootstrap skipped: ADMIN_PASSWORD must be at least 8 characters');
    return;
  }

  const id   = crypto.randomUUID();
  const hash = await bcrypt.hash(adminPassword, 10);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, tenant_id, role, display_name)
     VALUES ($1, $2, $3, NULL, 'consultant', $4)`,
    [id, adminEmail, hash, adminName || null]
  );
  console.log(`✓ Bootstrap created consultant user: ${adminEmail}`);
  console.log('  → After first login, remove ADMIN_PASSWORD from Render env vars');
}

module.exports = { bootstrap };
