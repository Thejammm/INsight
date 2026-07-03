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
-- Tenant status (Stage 6 Item 1): a suspended tenant's users are refused access
-- on every request (live check), not only at login. Commercial control for the
-- consultant (e.g. non-payment). Additive; DEFAULT 'active' backfills existing.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

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
-- Optional per-stage RIBA dates, e.g. {"5":"12 Jul 2026"} (Stage 4 Item 6).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS riba_dates JSONB NOT NULL DEFAULT '{}'::jsonb;

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
-- Guidance popup content per duty (Round 1 Item 1): { requires, evidence[] }.
-- The legal anchor is the citation column. Editable per duty by the consultant.
ALTER TABLE duty_templates ADD COLUMN IF NOT EXISTS guidance JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Planned RIBA stage per duty (Round 1 Item 5): the stage by which the duty is
-- expected to be discharged. Seeded per role (db/seedStages.js); a duty is
-- flagged a major non-conformance if the project passes this stage unsigned.
ALTER TABLE duty_templates ADD COLUMN IF NOT EXISTS planned_stage INTEGER;

-- Project duties (Stage 4 Item 4): a duty instance for one appointment (one
-- organisation, in one role, on one project). Instantiated from the role's duty
-- templates when the appointment is made (a snapshot — editable per project and
-- unaffected by later template edits). Each carries the review loop:
--   Outstanding -> Evidence outstanding (discharge recorded) -> Awaiting AHS
--   review (evidence attached) -> Reviewed / Returned (consultant only).
-- The derived status is computed in code (see routes/projectDuties.js).
CREATE TABLE IF NOT EXISTS project_duties (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  appointment_id   TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  duty_template_id TEXT REFERENCES duty_templates(id) ON DELETE SET NULL,
  seq              INTEGER NOT NULL DEFAULT 0,
  duty             TEXT NOT NULL,        -- snapshot of the duty wording (editable per project)
  citation         TEXT NOT NULL,        -- snapshot of the citation
  discharge        TEXT,                 -- how the appointed org will discharge it
  evidence         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name, addedBy, addedById, addedAt}] (linked to the register in Item 5)
  review_status    TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','reviewed','returned')),
  review_note      TEXT,
  reviewed_by      TEXT,                 -- named reviewer (display name)
  reviewed_by_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_project_duties_project     ON project_duties (project_id);
CREATE INDEX IF NOT EXISTS idx_project_duties_appointment ON project_duties (appointment_id);
-- Per-project planned RIBA stage override (Round 1 Item 5). NULL = inherit the
-- role default from the duty template. Editable per project by the consultant.
ALTER TABLE project_duties ADD COLUMN IF NOT EXISTS planned_stage INTEGER;

-- Document register (Stage 4 Item 5): one register per project. Duty evidence
-- links to entries here (by id) rather than storing loose filenames.
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id      TEXT REFERENCES tenants(id) ON DELETE SET NULL,   -- the org that owns/added it (NULL if consultant)
  name        TEXT NOT NULL,
  category    TEXT,                 -- e.g. Pre-construction information, CPP, Design risk register, H&S file
  version     TEXT,                 -- e.g. Rev C
  owner       TEXT,                 -- responsible person/organisation (free text)
  review_date DATE,                 -- next review date
  link        TEXT,                 -- URL / location
  status      TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','draft','superseded','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents (project_id);

-- Reference library (revisions). A `documents` row is a document REFERENCE (a
-- doc code + title, e.g. STR-CALC-001 "Structural calculations"). It is never an
-- uploaded file — it points to where the document lives. Each reference holds
-- controlled revisions here; duty evidence points to a specific revision.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_ref TEXT;   -- reference code
CREATE TABLE IF NOT EXISTS document_revisions (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rev          TEXT NOT NULL,        -- revision label, e.g. Rev C / P01
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','for_review','approved','superseded','rejected')),
  rev_date     DATE,
  link         TEXT,                 -- URL / location where this revision lives (a reference, not an upload)
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (document_id, rev)
);
CREATE INDEX IF NOT EXISTS idx_document_revisions_doc ON document_revisions (document_id);

-- Design deliverables register (Stage 5 Item 1): the design outputs a project
-- expects each designer / principal designer to produce and issue, tracked
-- against a planned RIBA stage (CDM 2015 Reg 9 — designers eliminate and reduce
-- foreseeable risk through design). A deliverable may point to a document-library
-- revision as its evidence of issue. Overdue is derived (project past the planned
-- stage while the deliverable is not yet issued/accepted) — a quality flag, kept
-- separate from the duty-holder compliance RAG.
CREATE TABLE IF NOT EXISTS design_deliverables (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id        TEXT REFERENCES tenants(id) ON DELETE SET NULL,   -- responsible designer/PD org (NULL = consultant-held)
  title         TEXT NOT NULL,
  discipline    TEXT,                 -- e.g. Architectural, Structural, MEP, Fire
  planned_stage INTEGER,              -- RIBA stage by which it should be issued
  status        TEXT NOT NULL DEFAULT 'outstanding'
                  CHECK (status IN ('outstanding','in_progress','issued','accepted','superseded')),
  revision_id   TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,  -- evidence of issue
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_design_deliverables_project ON design_deliverables (project_id);

-- Inspection & Test Plan items (Stage 5 Item 2): the construction-phase quality
-- checks a project plans and records — each work element/activity with its
-- acceptance reference and a control point (Hold / Witness / Surveillance /
-- Record), owned by the responsible contractor / principal contractor. Status
-- runs planned -> in_progress -> passed / failed (or n/a). A failed item is a
-- quality non-conformance; evidence points to a document-library revision (an
-- inspection record or test certificate). Overdue is the same derived quality
-- flag as deliverables — separate from the duty-holder compliance RAG.
CREATE TABLE IF NOT EXISTS itp_items (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id        TEXT REFERENCES tenants(id) ON DELETE SET NULL,   -- responsible contractor/PC org
  section       TEXT,                 -- e.g. Groundworks, Concrete, M&E
  title         TEXT NOT NULL,        -- the activity / element inspected
  reference     TEXT,                 -- acceptance criteria / spec / standard
  control_point TEXT NOT NULL DEFAULT 'record'
                  CHECK (control_point IN ('hold','witness','surveillance','record')),
  planned_stage INTEGER,
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','in_progress','passed','failed','na')),
  revision_id   TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,  -- inspection record / test cert
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_itp_items_project ON itp_items (project_id);

-- Non-conformance register (Stage 5 Item 3): quality non-conformances raised on a
-- project and tracked to close. Each records what is wrong, its severity, the
-- responsible organisation, a corrective action, and evidence of close (a
-- document-library revision). May cite a source (e.g. a failed ITP item or an
-- overdue deliverable) as free text. A quality workflow — separate from the
-- duty-holder compliance RAG.
CREATE TABLE IF NOT EXISTS ncrs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id            TEXT REFERENCES tenants(id) ON DELETE SET NULL,   -- responsible org
  ncr_ref           TEXT,                 -- optional reference code
  title             TEXT NOT NULL,
  description       TEXT,                 -- what is non-conforming
  severity          TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','major')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  corrective_action TEXT,                 -- what will be / was done
  source            TEXT,                 -- where it came from (free text, e.g. "ITP: pressure test")
  revision_id       TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,  -- evidence of close
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ncrs_project ON ncrs (project_id);

-- Declarations register (Stage 5 Item 5): a high-level checklist that the
-- required declarations (e.g. Building Regs 2010 Part 2A dutyholder competence
-- declarations) are in place. The app holds NO declaration content — each row
-- references the stored file via a document-library revision (its filename +
-- link) and records only whether it has been provided. The gate confirms all
-- required declarations are provided.
CREATE TABLE IF NOT EXISTS declarations (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id       TEXT REFERENCES tenants(id) ON DELETE SET NULL,   -- who the declaration is for / from
  title        TEXT NOT NULL,        -- e.g. Principal Designer competence declaration (BR Part 2A)
  status       TEXT NOT NULL DEFAULT 'outstanding'
                 CHECK (status IN ('outstanding','provided','na')),
  revision_id  TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,  -- the stored file (filename + link)
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_declarations_project ON declarations (project_id);
