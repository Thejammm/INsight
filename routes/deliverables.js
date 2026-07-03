// ══════════════════════════════════════════════════════════════
//  Design deliverables register (Stage 5 Item 1). Mounted at /api:
//    GET/POST   /api/projects/:id/deliverables
//    PATCH/DEL  /api/deliverables/:did
//
//  A design deliverable is a required design output (CDM 2015 Reg 9), owned by a
//  designer / principal designer organisation, tracked against a planned RIBA
//  stage and a status lifecycle (outstanding -> in_progress -> issued ->
//  accepted; or superseded). It may point to a document-library revision as its
//  evidence of issue. Any project participant may see and add; editing/deleting
//  is limited to the owning organisation, or the consultant.
//
//  "Overdue" is a QUALITY flag (project has passed the planned stage while the
//  deliverable is not yet issued/accepted) — deliberately separate from the
//  duty-holder compliance RAG.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');
const { stageName } = require('../db/ribaStages');

const router = express.Router();
const STATUSES = ['outstanding', 'in_progress', 'issued', 'accepted', 'superseded'];
const DONE = { issued: true, accepted: true };

const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);

function cleanBody(body, cur){
  cur = cur || {};
  const out = {
    title:      body.title      !== undefined ? str(body.title, 300)              : cur.title,
    discipline: body.discipline !== undefined ? (str(body.discipline, 120) || null) : cur.discipline,
    notes:      body.notes      !== undefined ? (str(body.notes, 500) || null)     : cur.notes,
    status:     body.status     !== undefined ? (STATUSES.includes(body.status) ? body.status : (cur.status || 'outstanding')) : (cur.status || 'outstanding'),
    revision_id: body.revisionId !== undefined ? (str(body.revisionId, 60) || null) : cur.revision_id,
  };
  // planned stage 0-7 or null
  if(body.plannedStage !== undefined){
    if(body.plannedStage === null || body.plannedStage === ''){ out.planned_stage = null; }
    else { const n = parseInt(body.plannedStage, 10); out.planned_stage = (Number.isNaN(n) || n < 0 || n > 7) ? (cur.planned_stage ?? null) : n; }
  } else { out.planned_stage = cur.planned_stage ?? null; }
  return out;
}
function isOverdue(row, currentStage){
  if(currentStage === null || currentStage === undefined) return false;
  if(row.planned_stage === null || row.planned_stage === undefined) return false;
  if(DONE[row.status]) return false;
  return Number(currentStage) > Number(row.planned_stage);
}

async function loadDeliverable(did){ const r = await pool.query(`SELECT * FROM design_deliverables WHERE id = $1 LIMIT 1`, [did]); return r.rows[0] || null; }
function canEdit(user, ownerOrgId){ return user.role === 'consultant' || (!!ownerOrgId && ownerOrgId === user.tenantId); }

// Validate that a revision belongs to this project (if one is being linked).
async function revisionOk(revisionId, projectId){
  if(!revisionId) return true;
  const r = await pool.query(
    `SELECT 1 FROM document_revisions rv JOIN documents d ON d.id = rv.document_id
      WHERE rv.id = $1 AND d.project_id = $2 LIMIT 1`, [revisionId, projectId]);
  return r.rows.length > 0;
}

// GET /api/projects/:id/deliverables
router.get('/projects/:id/deliverables', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const pr = await pool.query(`SELECT riba_stage FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    if(!pr.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const currentStage = pr.rows[0].riba_stage;
    const r = await pool.query(
      `SELECT dd.*, t.name AS org_name,
              d.id AS rev_document_id, d.doc_ref AS rev_doc_ref, d.name AS rev_doc_title, rv.rev AS rev_label, rv.link AS rev_link
         FROM design_deliverables dd
         LEFT JOIN tenants t             ON t.id = dd.org_id
         LEFT JOIN document_revisions rv ON rv.id = dd.revision_id
         LEFT JOIN documents d           ON d.id = rv.document_id
        WHERE dd.project_id = $1
        ORDER BY dd.discipline NULLS LAST, dd.created_at`,
      [projectId]
    );
    const deliverables = r.rows.map(row => {
      const mine = req.user.role === 'consultant' || row.org_id === req.user.tenantId;
      const evidence = row.revision_id ? {
        revisionId: row.revision_id,
        documentId: row.rev_document_id || null,
        name: (row.rev_doc_ref ? row.rev_doc_ref + ' ' : '') + (row.rev_doc_title || '') + (row.rev_label ? ' · ' + row.rev_label : ''),
        link: row.rev_link || null,
      } : null;
      return {
        id: row.id, orgId: row.org_id, orgName: row.org_name, title: row.title,
        discipline: row.discipline, plannedStage: row.planned_stage, plannedStageName: stageName(row.planned_stage),
        status: row.status, notes: row.notes, evidence,
        overdue: isOverdue(row, currentStage), canEdit: mine,
      };
    });
    res.json({ deliverables, currentStage });
  } catch(err){ console.error('GET deliverables error:', err); res.status(500).json({ error: 'server_error' }); }
});

// POST /api/projects/:id/deliverables — add (any participant; consultant may set orgId)
router.post('/projects/:id/deliverables', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {});
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, projectId))) return res.status(400).json({ error: 'revision_not_in_project' });
    const orgId = req.user.role === 'consultant' ? (req.body?.orgId || null) : req.user.tenantId;
    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO design_deliverables (id, project_id, org_id, title, discipline, planned_stage, status, revision_id, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [id, projectId, orgId, f.title, f.discipline, f.planned_stage, f.status, f.revision_id, f.notes, req.user.id]
    );
    res.json({ deliverable: { id: r.rows[0].id } });
  } catch(err){ console.error('POST deliverable error:', err); res.status(500).json({ error: 'server_error' }); }
});

// PATCH /api/deliverables/:did — edit
router.patch('/deliverables/:did', requireAuth, async (req, res) => {
  try {
    const cur = await loadDeliverable(req.params.did);
    if(!cur) return res.status(404).json({ error: 'deliverable_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {}, cur);
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, cur.project_id))) return res.status(400).json({ error: 'revision_not_in_project' });
    // Consultant may reassign the owning org.
    let orgId = cur.org_id;
    if(req.user.role === 'consultant' && req.body?.orgId !== undefined) orgId = req.body.orgId || null;
    const r = await pool.query(
      `UPDATE design_deliverables SET org_id=$1, title=$2, discipline=$3, planned_stage=$4, status=$5, revision_id=$6, notes=$7, updated_at=NOW(), updated_by=$8
        WHERE id=$9 RETURNING id`,
      [orgId, f.title, f.discipline, f.planned_stage, f.status, f.revision_id, f.notes, req.user.id, req.params.did]
    );
    res.json({ deliverable: { id: r.rows[0].id } });
  } catch(err){ console.error('PATCH deliverable error:', err); res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/deliverables/:did
router.delete('/deliverables/:did', requireAuth, async (req, res) => {
  try {
    const cur = await loadDeliverable(req.params.did);
    if(!cur) return res.status(404).json({ error: 'deliverable_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM design_deliverables WHERE id = $1`, [req.params.did]);
    res.json({ ok: true });
  } catch(err){ console.error('DELETE deliverable error:', err); res.status(500).json({ error: 'server_error' }); }
});

module.exports = { router };
