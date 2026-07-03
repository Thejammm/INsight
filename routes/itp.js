// ══════════════════════════════════════════════════════════════
//  Inspection & Test Plan register (Stage 5 Item 2). Mounted at /api:
//    GET/POST   /api/projects/:id/itp
//    PATCH/DEL  /api/itp/:iid
//
//  An ITP item is a construction-phase quality check: a work element/activity
//  with its acceptance reference and a control point (Hold / Witness /
//  Surveillance / Record), owned by the responsible contractor / principal
//  contractor. Status runs planned -> in_progress -> passed / failed (or n/a).
//  Evidence points to a document-library revision (inspection record / test
//  certificate). Any project participant may see and add; editing/deleting is
//  limited to the owning organisation, or the consultant.
//
//  "Overdue" (past the planned RIBA stage while not passed/na) and "failed"
//  are QUALITY flags — kept separate from the duty-holder compliance RAG.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');
const { stageName } = require('../db/ribaStages');

const router = express.Router();
const STATUSES = ['planned', 'in_progress', 'passed', 'failed', 'na'];
const CONTROL  = ['hold', 'witness', 'surveillance', 'record'];
const DONE = { passed: true, na: true };

const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);

function cleanBody(body, cur){
  cur = cur || {};
  const out = {
    section:   body.section   !== undefined ? (str(body.section, 120) || null)  : cur.section,
    title:     body.title     !== undefined ? str(body.title, 300)              : cur.title,
    reference: body.reference !== undefined ? (str(body.reference, 300) || null): cur.reference,
    notes:     body.notes     !== undefined ? (str(body.notes, 500) || null)    : cur.notes,
    control_point: body.controlPoint !== undefined ? (CONTROL.includes(body.controlPoint) ? body.controlPoint : (cur.control_point || 'record')) : (cur.control_point || 'record'),
    status:    body.status    !== undefined ? (STATUSES.includes(body.status) ? body.status : (cur.status || 'planned')) : (cur.status || 'planned'),
    revision_id: body.revisionId !== undefined ? (str(body.revisionId, 60) || null) : cur.revision_id,
  };
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

async function loadItem(iid){ const r = await pool.query(`SELECT * FROM itp_items WHERE id = $1 LIMIT 1`, [iid]); return r.rows[0] || null; }
function canEdit(user, ownerOrgId){ return user.role === 'consultant' || (!!ownerOrgId && ownerOrgId === user.tenantId); }
async function revisionOk(revisionId, projectId){
  if(!revisionId) return true;
  const r = await pool.query(
    `SELECT 1 FROM document_revisions rv JOIN documents d ON d.id = rv.document_id
      WHERE rv.id = $1 AND d.project_id = $2 LIMIT 1`, [revisionId, projectId]);
  return r.rows.length > 0;
}

// GET /api/projects/:id/itp
router.get('/projects/:id/itp', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const pr = await pool.query(`SELECT riba_stage FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    if(!pr.rows.length) return res.status(404).json({ error: 'project_not_found' });
    const currentStage = pr.rows[0].riba_stage;
    const r = await pool.query(
      `SELECT it.*, t.name AS org_name,
              d.id AS rev_document_id, d.doc_ref AS rev_doc_ref, d.name AS rev_doc_title, rv.rev AS rev_label, rv.link AS rev_link
         FROM itp_items it
         LEFT JOIN tenants t             ON t.id = it.org_id
         LEFT JOIN document_revisions rv ON rv.id = it.revision_id
         LEFT JOIN documents d           ON d.id = rv.document_id
        WHERE it.project_id = $1
        ORDER BY it.section NULLS LAST, it.created_at`,
      [projectId]
    );
    const items = r.rows.map(row => {
      const mine = req.user.role === 'consultant' || row.org_id === req.user.tenantId;
      const evidence = row.revision_id ? {
        revisionId: row.revision_id,
        documentId: row.rev_document_id || null,
        name: (row.rev_doc_ref ? row.rev_doc_ref + ' ' : '') + (row.rev_doc_title || '') + (row.rev_label ? ' · ' + row.rev_label : ''),
        link: row.rev_link || null,
      } : null;
      return {
        id: row.id, orgId: row.org_id, orgName: row.org_name, section: row.section,
        title: row.title, reference: row.reference, controlPoint: row.control_point,
        plannedStage: row.planned_stage, plannedStageName: stageName(row.planned_stage),
        status: row.status, notes: row.notes, evidence,
        overdue: isOverdue(row, currentStage), failed: row.status === 'failed', canEdit: mine,
      };
    });
    res.json({ items, currentStage });
  } catch(err){ console.error('GET itp error:', err); res.status(500).json({ error: 'server_error' }); }
});

// POST /api/projects/:id/itp
router.post('/projects/:id/itp', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {});
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, projectId))) return res.status(400).json({ error: 'revision_not_in_project' });
    const orgId = req.user.role === 'consultant' ? (req.body?.orgId || null) : req.user.tenantId;
    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO itp_items (id, project_id, org_id, section, title, reference, control_point, planned_stage, status, revision_id, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
      [id, projectId, orgId, f.section, f.title, f.reference, f.control_point, f.planned_stage, f.status, f.revision_id, f.notes, req.user.id]
    );
    res.json({ item: { id: r.rows[0].id } });
  } catch(err){ console.error('POST itp error:', err); res.status(500).json({ error: 'server_error' }); }
});

// PATCH /api/itp/:iid
router.patch('/itp/:iid', requireAuth, async (req, res) => {
  try {
    const cur = await loadItem(req.params.iid);
    if(!cur) return res.status(404).json({ error: 'itp_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {}, cur);
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, cur.project_id))) return res.status(400).json({ error: 'revision_not_in_project' });
    let orgId = cur.org_id;
    if(req.user.role === 'consultant' && req.body?.orgId !== undefined) orgId = req.body.orgId || null;
    const r = await pool.query(
      `UPDATE itp_items SET org_id=$1, section=$2, title=$3, reference=$4, control_point=$5, planned_stage=$6, status=$7, revision_id=$8, notes=$9, updated_at=NOW(), updated_by=$10
        WHERE id=$11 RETURNING id`,
      [orgId, f.section, f.title, f.reference, f.control_point, f.planned_stage, f.status, f.revision_id, f.notes, req.user.id, req.params.iid]
    );
    res.json({ item: { id: r.rows[0].id } });
  } catch(err){ console.error('PATCH itp error:', err); res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/itp/:iid
router.delete('/itp/:iid', requireAuth, async (req, res) => {
  try {
    const cur = await loadItem(req.params.iid);
    if(!cur) return res.status(404).json({ error: 'itp_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM itp_items WHERE id = $1`, [req.params.iid]);
    res.json({ ok: true });
  } catch(err){ console.error('DELETE itp error:', err); res.status(500).json({ error: 'server_error' }); }
});

module.exports = { router };
