-- ══════════════════════════════════════════════════════════════
--  H&S Management System — Database Schema
--  Run automatically on server startup. Idempotent.
-- ══════════════════════════════════════════════════════════════

-- Tenants: each client business is one tenant.
-- A consultant user has tenant_id NULL (sees all tenants).
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,           -- e.g. 'easy-travel'
  name         TEXT NOT NULL,              -- display name e.g. 'Easy Travel Leeds'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-tenant client configuration: icon, location, default inspection type,
-- pack selection and branding. Replaces the hardcoded CLIENTS constant that used
-- to live in the front-end (house rule: no customer data in source). Additive so
-- existing tenants keep working; DEFAULT '{}' backfills every existing row with an
-- empty config the front-end reads as neutral defaults.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Users: anyone who can log in.
-- role = 'consultant' → can see/manage all tenants (Archer staff)
-- role = 'client_user' → scoped to one tenant
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  role          TEXT NOT NULL CHECK (role IN ('consultant', 'client_user')),
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);

-- Soft-deactivation flag. An inactive user cannot log in, but their record
-- (and any inspection history under their tenant) is preserved — we deactivate
-- rather than hard-delete. Added via ALTER so it also applies to existing
-- databases on deploy; DEFAULT TRUE backfills every existing user as active.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Plain-text copy of the password, kept so the consultant can read back the
-- logins they hand to clients. Written whenever a password is set/reset; login
-- still verifies against password_hash. NULL for users whose password predates
-- this column (their original password was never stored in readable form).
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_plain TEXT;

-- App state: one row per tenant holding the entire S blob from the frontend.
-- Stored as JSONB so we can query inside it later if needed.
CREATE TABLE IF NOT EXISTS app_state (
  tenant_id   TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);
