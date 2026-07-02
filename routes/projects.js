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
const { deriveStatus, asEvidence, computeDutyStats, outstandingList, STATUS_LABELS, REVIEW_WORDING } = require('./dutyStatus');
const { RIBA_STAGES } = require('../db/ribaStages');

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
    `SELECT id, project_id, review_status, discharge, evidence FROM project_duties WHERE project_id IN (${placeholders})`,
    ids
  );
  const byProject = {};
  dr.rows.forEach(r => { (byProject[r.project_id] = byProject[r.project_id] || []).push(r); });
  return projects.map(p => ({ ...p, summary: computeDutyStats(byProject[p.id] || []) }));
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
    res.json({ project: p.rows[0], appointments: a.rows, myRoles });
  } catch(err){
    console.error('GET /projects/:id error:', err);
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
      `SELECT pd.*, a.org_id, t.name AS org_name
         FROM project_duties pd
         JOIN appointments a ON a.id = pd.appointment_id
         JOIN tenants t       ON t.id = a.org_id
        WHERE pd.project_id = $1
        ORDER BY t.name, pd.role, pd.seq`,
      [id]
    );
    const duties = r.rows.map(pd => {
      const status = deriveStatus(pd);
      const mine = req.user.role === 'consultant' || pd.org_id === req.user.tenantId;
      return {
        id: pd.id, appointmentId: pd.appointment_id, orgId: pd.org_id, orgName: pd.org_name,
        role: pd.role, seq: pd.seq, duty: pd.duty, citation: pd.citation,
        discharge: pd.discharge, evidence: asEvidence(pd.evidence),
        status, statusLabel: STATUS_LABELS[status],
        reviewStatus: pd.review_status, reviewNote: pd.review_note,
        reviewedBy: pd.reviewed_by, reviewedAt: pd.reviewed_at,
        canEdit: mine,                    // may this user record discharge / evidence
      };
    });
    res.json({ duties, wording: REVIEW_WORDING });
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
      `SELECT pd.*, t.name AS org_name
         FROM project_duties pd
         JOIN appointments a ON a.id = pd.appointment_id
         JOIN tenants t       ON t.id = a.org_id
        WHERE pd.project_id = $1`,
      [id]
    );
    res.json({
      project: p.rows[0],
      currentStage: p.rows[0].riba_stage,
      stats: computeDutyStats(dr.rows),
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
      `SELECT id, seq, duty, citation FROM duty_templates
        WHERE role = $1 AND is_active = TRUE ORDER BY seq`,
      [role]
    );
    for(const d of tpl.rows){
      await pool.query(
        `INSERT INTO project_duties (id, project_id, appointment_id, role, duty_template_id, seq, duty, citation, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [crypto.randomUUID(), projectId, id, role, d.id, d.seq, d.duty, d.citation, req.user.id]
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
