-- ══════════════════════════════════════════════════════════════
--  AHS InSight — Database Schema
--  Run automatically on server startup. Idempotent.
--
--  Auth layer (tenants / users / app_state) is shared with the other AHS apps.
--  In InSight a `tenant` IS an organisation (a company: a client, a designer,
--  a contractor, ...). Users belong to one organisation (users.tenant_id) and
--  reach projects through their organisation's appointments (see below). The
--  relational compliance model (projects, appointments, and later duties /
--  evidence) is the InSight-specific part.
-- ══════════════════════════════════════════════════════════════

-- Tenants: in InSight, one organisation (company).
-- A consultant user has tenant_id NULL (AHS — sees all organisations/projects).
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

-- ══════════════════════════════════════════════════════════════
--  InSight relational model (Stage 4 Item 2)
--  Projects, and the dutyholder appointments that link an organisation to a
--  project under a role. One organisation can hold different roles on different
--  projects; a project has many appointed organisations. A user (through their
--  organisation = tenant_id) can reach a project only if that organisation holds
--  an appointment on it; the consultant (tenant_id NULL) reaches every project.
--  Access is enforced server-side in routes/projects.js, never by the client.
-- ══════════════════════════════════════════════════════════════

-- Projects: one construction project.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  ref         TEXT,                        -- client/project reference, optional
  description TEXT,
  riba_stage  INTEGER,                     -- current RIBA Plan of Work stage 0-7, optional
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);

-- Dutyholder appointments: an organisation appointed to a project under a role.
CREATE TABLE IF NOT EXISTS appointments (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN (
                 'client','principal_designer','designer','principal_contractor',
                 'contractor','br_principal_designer','br_principal_contractor')),
  appointed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  appointed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (project_id, org_id, role)
);
CREATE INDEX IF NOT EXISTS idx_appointments_project ON appointments (project_id);
CREATE INDEX IF NOT EXISTS idx_appointments_org     ON appointments (org_id);

-- Duty templates (Stage 4 Item 3): the canonical dutyholder duties per role,
-- seeded from the verified framework (CDM 2015 + Building Regs 2010 Part 2A).
-- Duties are data — the consultant can edit, add, retire (is_active) them. Seeded
-- once into an empty table (db/seedDuties.js); edits are never overwritten on
-- redeploy. Per-project duty instances + the review loop build on these next.
CREATE TABLE IF NOT EXISTS duty_templates (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN (
               'client','principal_designer','designer','principal_contractor',
               'contractor','br_principal_designer','br_principal_contractor')),
  seq        INTEGER NOT NULL DEFAULT 0,
  regime     TEXT NOT NULL DEFAULT 'cdm' CHECK (regime IN ('cdm','building_regs')),
  duty       TEXT NOT NULL,
  citation   TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_duty_templates_role ON duty_templates (role);
