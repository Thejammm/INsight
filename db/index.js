// ══════════════════════════════════════════════════════════════
//  Database connection + schema migration runner
// ══════════════════════════════════════════════════════════════
const { Pool }   = require('pg');
const fs         = require('fs');
const path       = require('path');

if(!process.env.DATABASE_URL){
  console.error('FATAL: DATABASE_URL environment variable is not set.');
  console.error('Set it locally in .env or in Render → service → Environment.');
  process.exit(1);
}

// Render's internal Postgres URL doesn't require SSL.
// External URLs (e.g. from a laptop) do — auto-detect by hostname.
const needsSsl = /\.render\.com|\.render-postgres\.com/i.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', (err) => {
  console.error('Unexpected pg pool error:', err);
});

// Run schema.sql on startup. Idempotent (CREATE TABLE IF NOT EXISTS).
async function migrate(){
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('✓ Schema migration applied');
  } catch(err){
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Quick health check used by /healthz
async function isHealthy(){
  try {
    const r = await pool.query('SELECT 1 AS ok');
    return r.rows[0].ok === 1;
  } catch(e){
    return false;
  }
}

module.exports = { pool, migrate, isHealthy };
