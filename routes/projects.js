// ══════════════════════════════════════════════════════════════
//  /api/projects — projects, dutyholder appointments, access control
//
//  Access model (enforced here, server-side — never trust the client):
//   - consultant (tenant_id NULL) → sees and manages every project.
//   - client_user → sees a project ONLY if their organisation (tenant_id)
//     holds at least one appointment on it. All create/edit/appoint actions
//     are consultant-only; client users are read-only here.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireConsultant } = require('../middleware/auth');
const { deriveStatus, asEvidence, computeDutyStats, outstandingList, STATUS_LABELS, REVIEW_WORDING, asReviewers, reviewerRefForRole, canReviewDuty } = require('./dutyStatus');
const { RIBA_STAGES, ROLE_STAGE, stageName } = require('../db/ribaStages');

// Effective planned stage for a duty row: per-project override, else the duty
// template default, else the role default. A duty is a major non-conformance
// (STAGE OVERDUE) when the project has moved past its planned stage and it is
// not yet signed off (reviewed).
function effectiveStage(pd){
  if(pd.planned_stage !== null && pd.planned_stage !== undefined) return Number(pd.planned_stage);
  if(pd.dt_planned_stage !== null && pd.dt_planned_stage !== undefined) return Number(pd.dt_planned_stage);
  return ROLE_STAGE[pd.role] !== undefined ? ROLE_STAGE[pd.role] : null;
}
function isOverdue(pd, currentStage, status){
  if(currentStage === null || currentStage === undefined) return false;
  const ps = effectiveStage(pd);
  if(ps === null) return false;
  return Number(currentStage) > ps && status !== 'reviewed';
}

const router = express.Router();

// Dutyholder roles an organisation can be appointed under (CDM 2015 + Building
// Regs). Kept in step with the CHECK constraint in db/schema.sql.
const ROLES = [
  'client', 'principal_designer', 'designer', 'principal_contractor',
  'contractor', 'br_principal_designer', 'br_principal_contractor'
];

// Does this user's organisation reach this project? Consultant → always.
async function userCanAccessProject(user, projectId){
  if(user.role === 'consultant') return true;
  if(!user.tenantId) return false;
  const r = await pool.query(
    `SELECT 1 FROM appointments WHERE project_id = $1 AND org_id = $2 LIMIT 1`,
    [projectId, user.tenantId]
  );
  return r.rows.length > 0;
}

// Attach a compliance roll-up (signed-off %, RAG, counts) to each project, in
// one extra query, for the landing-page cross-project view.
async function attachSummaries(projects){
  if(!projects.length) return projects;
  const ids = projects.map(p => p.id);
  const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
  const dr = await pool.query(
    `SELECT pd.id, pd.project_id, pd.role, pd.review_status, pd.discharge, pd.evidence,
            pd.planned_stage, dt.planned_stage AS dt_planned_stage
       FROM project_duties pd
       LEFT JOIN duty_templates dt ON dt.id = pd.duty_template_id
      WHERE pd.project_id IN (${placeholders})`,
    ids
  );
  const byProject = {};
  dr.rows.forEach(r => { (byProject[r.project_id] = byProject[r.project_id] || []).push(r); });
  return projects.map(p => {
    const rows = byProject[p.id] || [];
    const summary = computeDutyStats(rows);
    summary.overdue = rows.filter(pd => isOverdue(pd, p.riba_stage, deriveStatus(pd))).length;
    if(summary.overdue > 0){ summary.rag = 'red'; summary.ragLabel = 'Behind'; }
    return { ...p, summary };
  });
}

// ── List projects visible to the caller ─────────────────────────
// GET /api/projects
router.get('/', requireAuth, async (req, res) => {
  try {
    // org_count comes from a grouped derived table (a LEFT JOIN), which is
    // portable and avoids a correlated scalar subquery.
    const COUNT_JOIN = `LEFT JOIN (SELECT project_id, COUNT(*) AS n FROM appointments GROUP BY project_id) c ON c.project_id = p.id`;
    if(req.user.role === 'consultant'){
      const r = await pool.query(
        `SELECT p.*, COALESCE(c.n, 0) AS org_count
           FROM projects p ${COUNT_JOIN}
          ORDER BY p.created_at DESC`
      );
      const projects = await attachSummaries(r.rows.map(p => ({ ...p, org_count: Number(p.org_count) })));
      return res.json({ projects });
    }
    // client_user: only projects their organisation is appointed to, plus the
    // role(s) their organisation holds on each (roles joined in JS).
    if(!req.user.tenantId) return res.json({ projects: [] });
    const r = await pool.query(
      `SELECT p.*, COALESCE(c.n, 0) AS org_count
         FROM projects p ${COUNT_JOIN}
        WHERE p.id IN (SELECT project_id FROM appointments WHERE org_id = $1)
        ORDER BY p.created_at DESC`,
      [req.user.tenantId]
    );
    const mine = await pool.query(
      `SELECT project_id, role FROM appointments WHERE org_id = $1`,
      [req.user.tenantId]
    );
    const rolesByProject = {};
    mine.rows.forEach(row => { (rolesByProject[row.project_id] = rolesByProject[row.project_id] || []).push(row.role); });
    const projects = await attachSummaries(r.rows.map(p => ({ ...p, org_count: Number(p.org_count), my_roles: rolesByProject[p.id] || [] })));
    res.json({ projects });
  } catch(err){
    console.error('GET /projects error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Create a project (consultant only) ──────────────────────────
// POST /api/projects  { name, ref?, description?, ribaStage? }
router.post('/', requireAuth, requireConsultant, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if(!name) return res.status(400).json({ error: 'name_required' });
  const ref         = req.body?.ref ? String(req.body.ref).trim() : null;
  const description = req.body?.description ? String(req.body.description).trim() : null;
  let ribaStage = null;
  if(req.body?.ribaStage !== undefined && req.body.ribaStage !== null && req.body.ribaStage !== ''){
    const n = parseInt(req.body.ribaStage, 10);
    if(!Number.isNaN(n) && n >= 0 && n <= 7) ribaStage = n;
  }
  try {
    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO projects (id, name, ref, description, riba_stage, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, name, ref, description, ribaStage, req.user.id]
    );
    res.json({ project: r.rows[0] });
  } catch(err){
    console.error('POST /projects error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Project detail + its appointments (access-checked) ──────────
// GET /api/projects/:id
router.get('/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, id))){
      return res.status(403).json({ error: 'forbidden' });
    }
    const p = await pool.query(`SELECT * FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if(!p.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const a = await pool.query(
      `SELECT a.id, a.role, a.org_id, t.name AS org_name, a.appointed_at
         FROM appointments a
         JOIN tenants t ON t.id = a.org_id
        WHERE a.project_id = $1
        ORDER BY a.role, t.name`,
      [id]
    );
    const myRoles = req.user.role === 'consultant'
      ? null
      : a.rows.filter(x => x.org_id === req.user.tenantId).map(x => x.role);
    const proj = p.rows[0];
    proj.modules = normModules(proj.modules);
    proj.reviewers = normReviewers(proj.reviewers);
    res.json({ project: proj, appointments: a.rows, myRoles });
  } catch(err){
    console.error('GET /projects/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Normalise the module switches (dutyholder is always on and not stored).
function normModules(v){
  const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v
          : (typeof v === 'string' ? (()=>{ try { return JSON.parse(v)||{}; } catch(e){ return {}; } })() : {});
  return { dutyholder: true, design: o.design !== false, construction: o.construction !== false };
}

// Normalise the per-role reviewer map: keep only valid roles with a non-blank
// string ref. Every other role is implicitly 'ahs' (see reviewerRefForRole).
function normReviewers(v){
  const o = asReviewers(v);
  const out = {};
  ROLES.forEach(r => { const ref = o[r]; if(ref && String(ref).trim()) out[r] = String(ref).trim(); });
  return out;
}

// ── Toggle a project's modules (consultant only) ────────────────
// PATCH /api/projects/:id/modules  { design?: bool, construction?: bool }
// Dutyholder compliance cannot be disabled. Each change is audit-logged.
router.patch('/:id/modules', requireAuth, requireConsultant, async (req, res) => {
  const id = req.params.id;
  try {
    const cur = await pool.query(`SELECT modules, module_log FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if(!cur.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const before = normModules(cur.rows[0].modules);
    const next = { design: before.design, construction: before.construction };
    const log = Array.isArray(cur.rows[0].module_log) ? cur.rows[0].module_log.slice() : [];
    const who = req.user.name || req.user.email || 'consultant';
    ['design','construction'].forEach(m => {
      if(typeof req.body?.[m] === 'boolean' && req.body[m] !== next[m]){
        next[m] = req.body[m];
        log.push({ module: m, on: req.body[m], by: who, at: new Date().toISOString() });
      }
    });
    await pool.query(`UPDATE projects SET modules = $1::jsonb, module_log = $2::jsonb WHERE id = $3`,
      [JSON.stringify(next), JSON.stringify(log.slice(-100)), id]);
    res.json({ modules: normModules(next) });
  } catch(err){
    console.error('PATCH /projects/:id/modules error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Set the reviewer for a role (consultant only) ───────────────
// PATCH /api/projects/:id/reviewers  { role, reviewerId }
// reviewerId is 'ahs' (or blank → AHS), or an organisation appointed on this
// project. Guard: the chosen org must not itself hold that role (a role cannot
// review its own duties). Stored per project in projects.reviewers.
router.patch('/:id/reviewers', requireAuth, requireConsultant, async (req, res) => {
  const id   = req.params.id;
  const role = String(req.body?.role || '').trim();
  let ref    = String(req.body?.reviewerId || '').trim();
  if(!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  try {
    const cur = await pool.query(`SELECT reviewers FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if(!cur.rows.length) return res.status(404).json({ error: 'project_not_found' });
    if(!ref || ref === 'ahs'){
      ref = 'ahs';
    } else {
      // The ref must be an organisation appointed on this project, and it must
      // not be appointed under `role` (no reviewing your own homework).
      const ap = await pool.query(
        `SELECT role FROM appointments WHERE project_id = $1 AND org_id = $2`, [id, ref]);
      if(!ap.rows.length) return res.status(400).json({ error: 'reviewer_not_appointed' });
      if(ap.rows.some(x => x.role === role)) return res.status(400).json({ error: 'reviewer_holds_role' });
    }
    const next = normReviewers(cur.rows[0].reviewers);
    if(ref === 'ahs') delete next[role]; else next[role] = ref;   // 'ahs' is the implicit default
    await pool.query(`UPDATE projects SET reviewers = $1::jsonb WHERE id = $2`, [JSON.stringify(next), id]);
    res.json({ reviewers: next });
  } catch(err){
    console.error('PATCH /projects/:id/reviewers error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Project duties with their review-loop status (access-checked) ─
// GET /api/projects/:id/duties  → all duties on the project, grouped by
// appointment (organisation + role), each with its derived status. Includes the
// standing AHS review wording so the UI and PDFs use it verbatim.
router.get('/:id/duties', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, id))){
      return res.status(403).json({ error: 'forbidden' });
    }
    const r = await pool.query(
      `SELECT pd.*, a.org_id, t.name AS org_name, dt.guidance, dt.planned_stage AS dt_planned_stage, pr.riba_stage, pr.reviewers
         FROM project_duties pd
         JOIN appointments a  ON a.id = pd.appointment_id
         JOIN tenants t        ON t.id = a.org_id
         JOIN projects pr      ON pr.id = pd.project_id
         LEFT JOIN duty_templates dt ON dt.id = pd.duty_template_id
        WHERE pd.project_id = $1
        ORDER BY t.name, pd.role, pd.seq`,
      [id]
    );
    const currentStage = r.rows.length ? r.rows[0].riba_stage : null;
    const reviewers = normReviewers(r.rows.length ? r.rows[0].reviewers : {});
    const duties = r.rows.map(pd => {
      const status = deriveStatus(pd);
      const mine = req.user.role === 'consultant' || pd.org_id === req.user.tenantId;
      const g = (pd.guidance && typeof pd.guidance === 'object' && !Array.isArray(pd.guidance)) ? pd.guidance
              : (typeof pd.guidance === 'string' ? (()=>{ try { return JSON.parse(pd.guidance)||{}; } catch(e){ return {}; } })() : {});
      const plannedStage = effectiveStage(pd);
      const overdue = isOverdue(pd, currentStage, status);
      return {
        id: pd.id, appointmentId: pd.appointment_id, orgId: pd.org_id, orgName: pd.org_name,
        role: pd.role, seq: pd.seq, duty: pd.duty, citation: pd.citation,
        discharge: pd.discharge, evidence: asEvidence(pd.evidence),
        status, statusLabel: STATUS_LABELS[status],
        plannedStage, plannedStageName: stageName(plannedStage), overdue,
        updatedAt: pd.updated_at,
        reviewStatus: pd.review_status, reviewNote: pd.review_note,
        reviewedBy: pd.reviewed_by, reviewedByOrg: pd.reviewed_by_org, reviewedAt: pd.reviewed_at,
        reviewerRef: reviewerRefForRole(reviewers, pd.role),   // who signs this role off ('ahs' | org id)
        canReview: canReviewDuty(req.user, pd, reviewers),     // may THIS user sign off / return
        canEdit: mine,                    // may this user record discharge / evidence
        guidance: (g.requires || (g.evidence && g.evidence.length)) ? { requires: g.requires || '', evidence: Array.isArray(g.evidence) ? g.evidence : [] } : null,
      };
    });
    res.json({ duties, currentStage, wording: REVIEW_WORDING });
  } catch(err){
    console.error('GET /projects/:id/duties error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Coerce a jsonb object value to a plain object (defensive against strings/null).
function asObj(v){
  if(v && typeof v === 'object' && !Array.isArray(v)) return v;
  if(typeof v === 'string'){ try { const j = JSON.parse(v); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; } catch(e){ return {}; } }
  return {};
}

// ── RIBA spine (Item 6) ─────────────────────────────────────────
// GET /api/projects/:id/riba → the 8 RIBA stages with the stage-appropriate CDM
// narrative, each project's per-stage dates, and which stage is current.
router.get('/:id/riba', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, id))) return res.status(403).json({ error: 'forbidden' });
    const p = await pool.query(`SELECT riba_stage, riba_dates FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if(!p.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const dates = asObj(p.rows[0].riba_dates);
    const current = p.rows[0].riba_stage;
    const stages = RIBA_STAGES.map(s => ({
      ...s,
      date: dates[String(s.n)] || null,
      current: s.n === current,
      state: current == null ? 'upcoming' : (s.n < current ? 'done' : s.n === current ? 'current' : 'upcoming'),
    }));
    res.json({ currentStage: current, stages });
  } catch(err){
    console.error('GET /projects/:id/riba error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/projects/:id/riba (consultant)  { currentStage?, dates?:{ "5":"12 Jul 2026" } }
router.patch('/:id/riba', requireAuth, requireConsultant, async (req, res) => {
  const id = req.params.id;
  try {
    const cur = await pool.query(`SELECT riba_stage, riba_dates FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if(!cur.rows.length) return res.status(404).json({ error: 'project_not_found' });
    let stage = cur.rows[0].riba_stage;
    if(req.body?.currentStage !== undefined){
      if(req.body.currentStage === null){ stage = null; }
      else { const n = parseInt(req.body.currentStage, 10); if(!Number.isNaN(n) && n >= 0 && n <= 7) stage = n; }
    }
    const dates = asObj(cur.rows[0].riba_dates);
    if(req.body?.dates && typeof req.body.dates === 'object'){
      Object.keys(req.body.dates).forEach(k => {
        const n = parseInt(k, 10); if(n < 0 || n > 7 || Number.isNaN(n)) return;
        const v = req.body.dates[k];
        if(v === null || v === '') delete dates[String(n)]; else dates[String(n)] = String(v).slice(0, 40);
      });
    }
    await pool.query(`UPDATE projects SET riba_stage = $1, riba_dates = $2::jsonb WHERE id = $3`, [stage, JSON.stringify(dates), id]);
    res.json({ ok: true, currentStage: stage, dates });
  } catch(err){
    console.error('PATCH /projects/:id/riba error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Project dashboard (Item 7) ──────────────────────────────────
// GET /api/projects/:id/dashboard → compliance figures + most-urgent-first
// outstanding list, computed from the real duty data.
router.get('/:id/dashboard', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, id))) return res.status(403).json({ error: 'forbidden' });
    const p = await pool.query(`SELECT * FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if(!p.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const dr = await pool.query(
      `SELECT pd.*, t.name AS org_name, dt.planned_stage AS dt_planned_stage
         FROM project_duties pd
         JOIN appointments a ON a.id = pd.appointment_id
         JOIN tenants t       ON t.id = a.org_id
         LEFT JOIN duty_templates dt ON dt.id = pd.duty_template_id
        WHERE pd.project_id = $1`,
      [id]
    );
    const currentStage = p.rows[0].riba_stage;
    const stats = computeDutyStats(dr.rows);
    // Stage-overdue duties are major non-conformances: count them and, if any,
    // force the project RAG to red regardless of the signed-off percentage.
    stats.overdue = dr.rows.filter(pd => isOverdue(pd, currentStage, deriveStatus(pd))).length;
    if(stats.overdue > 0){ stats.rag = 'red'; stats.ragLabel = 'Behind'; }
    res.json({
      project: p.rows[0],
      currentStage,
      stats,
      outstanding: outstandingList(dr.rows),
    });
  } catch(err){
    console.error('GET /projects/:id/dashboard error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Update a project (consultant only) ──────────────────────────
// PATCH /api/projects/:id  { name?, ref?, description?, ribaStage?, status? }
router.patch('/:id', requireAuth, requireConsultant, async (req, res) => {
  const id = req.params.id;
  try {
    const cur = await pool.query(`SELECT * FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if(!cur.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const c = cur.rows[0];

    const name = req.body?.name !== undefined ? String(req.body.name).trim() : c.name;
    if(!name) return res.status(400).json({ error: 'name_required' });
    const ref = req.body?.ref !== undefined ? (String(req.body.ref).trim() || null) : c.ref;
    const description = req.body?.description !== undefined ? (String(req.body.description).trim() || null) : c.description;
    let ribaStage = c.riba_stage;
    if(req.body?.ribaStage !== undefined){
      if(req.body.ribaStage === null || req.body.ribaStage === ''){ ribaStage = null; }
      else { const n = parseInt(req.body.ribaStage, 10); ribaStage = (!Number.isNaN(n) && n >= 0 && n <= 7) ? n : c.riba_stage; }
    }
    let status = c.status;
    if(req.body?.status !== undefined){
      status = ['active','archived'].includes(req.body.status) ? req.body.status : c.status;
    }
    const r = await pool.query(
      `UPDATE projects SET name = $1, ref = $2, description = $3, riba_stage = $4, status = $5
         WHERE id = $6 RETURNING *`,
      [name, ref, description, ribaStage, status, id]
    );
    res.json({ project: r.rows[0] });
  } catch(err){
    console.error('PATCH /projects/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Appoint an organisation to a role (consultant only) ─────────
// POST /api/projects/:id/appointments  { orgId, role }
router.post('/:id/appointments', requireAuth, requireConsultant, async (req, res) => {
  const projectId = req.params.id;
  const orgId = String(req.body?.orgId || '').trim();
  const role  = String(req.body?.role || '').trim();
  if(!orgId) return res.status(400).json({ error: 'org_required' });
  if(!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  try {
    const p = await pool.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if(!p.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const t = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [orgId]);
    if(!t.rows.length) return res.status(404).json({ error: 'org_not_found' });

    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO appointments (id, project_id, org_id, role, appointed_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, projectId, orgId, role, req.user.id]
    );

    // Instantiate this appointment's duties from the role's active duty
    // templates — a per-project snapshot, editable and unaffected by later
    // template edits. This is the review loop's starting point.
    const tpl = await pool.query(
      `SELECT id, seq, duty, citation, planned_stage FROM duty_templates
        WHERE role = $1 AND is_active = TRUE ORDER BY seq`,
      [role]
    );
    const roleDefault = ROLE_STAGE[role] !== undefined ? ROLE_STAGE[role] : null;
    for(const d of tpl.rows){
      const ps = (d.planned_stage !== null && d.planned_stage !== undefined) ? d.planned_stage : roleDefault;
      await pool.query(
        `INSERT INTO project_duties (id, project_id, appointment_id, role, duty_template_id, seq, duty, citation, planned_stage, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [crypto.randomUUID(), projectId, id, role, d.id, d.seq, d.duty, d.citation, ps, req.user.id]
      );
    }
    res.json({ appointment: r.rows[0], dutiesCreated: tpl.rows.length });
  } catch(err){
    if(err.code === '23505') return res.status(409).json({ error: 'appointment_exists' });
    console.error('POST /projects/:id/appointments error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Remove an appointment (consultant only) ─────────────────────
// DELETE /api/projects/:id/appointments/:appId
router.delete('/:id/appointments/:appId', requireAuth, requireConsultant, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM appointments WHERE id = $1 AND project_id = $2`,
      [req.params.appId, req.params.id]
    );
    if(r.rowCount === 0) return res.status(404).json({ error: 'appointment_not_found' });
    res.json({ ok: true });
  } catch(err){
    console.error('DELETE appointment error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Delete a project (consultant only) ──────────────────────────
// DELETE /api/projects/:id — cascades to its appointments and their duties.
router.delete('/:id', requireAuth, requireConsultant, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM projects WHERE id = $1`, [req.params.id]);
    if(r.rowCount === 0) return res.status(404).json({ error: 'project_not_found' });
    res.json({ ok: true });
  } catch(err){
    console.error('DELETE /projects/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = { router, userCanAccessProject, ROLES };
