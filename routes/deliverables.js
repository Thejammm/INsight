// ══════════════════════════════════════════════════════════════
//  Design deliverables register — assurance / gate model (Round 2 Part A1).
//  Mounted at /api:
//    GET/POST   /api/projects/:id/deliverables
//    PATCH/DEL  /api/deliverables/:did
//    POST       /api/deliverables/:did/submit   {revision?, stage?}  (owner/consultant)
//    POST       /api/deliverables/:did/review   {action, note?}      (consultant)
//    POST       /api/deliverables/:did/reopen                        (consultant)
//
//  A deliverable is the finite thing that must exist (fire strategy, structural
//  calcs, ...). The team updates `current_revision` as revisions churn — no
//  review per revision. Gate reviews fire at STAGE GATES (and on compliance-
//  critical items): Not submitted -> Submitted for gate review -> Reviewed
//  (suitable) / Returned with reasons, recording which revision at which stage.
//  Stage-overdue (project past required-by stage without a Reviewed gate) is a
//  major non-conformance — a QUALITY flag, separate from the duty-holder RAG.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireConsultant } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');
const { stageName } = require('../db/ribaStages');
const { REVIEW_WORDING } = require('./dutyStatus');
const { DEFAULT_DELIVERABLES } = require('../db/defaultDeliverables');

const router = express.Router();
const GATE = ['not_submitted', 'submitted', 'reviewed', 'returned'];
const GATE_LABEL = { not_submitted:'Not submitted', submitted:'Submitted for gate review', reviewed:'Reviewed (suitable)', returned:'Returned with reasons' };

const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);
function stageOf(v){ if(v===undefined||v===null||v==='') return null; const n=parseInt(v,10); return (Number.isNaN(n)||n<0||n>7)?null:n; }

function cleanBody(body, cur){
  cur = cur || {};
  const out = {
    title:            body.title      !== undefined ? str(body.title, 300)              : cur.title,
    discipline:       body.discipline !== undefined ? (str(body.discipline, 120)||null) : cur.discipline,
    notes:            body.notes      !== undefined ? (str(body.notes, 500)||null)      : cur.notes,
    current_revision: body.currentRevision !== undefined ? (str(body.currentRevision, 60)||null) : cur.current_revision,
    external_url:     body.externalUrl !== undefined ? (str(body.externalUrl, 1000)||null) : cur.external_url,
    revision_id:      body.revisionId !== undefined ? (str(body.revisionId, 60)||null)  : cur.revision_id,
  };
  out.compliance_critical = body.complianceCritical !== undefined ? !!body.complianceCritical : (cur.compliance_critical || false);
  out.planned_stage = body.plannedStage !== undefined ? stageOf(body.plannedStage) : (cur.planned_stage ?? null);
  return out;
}
function isOverdue(row, currentStage){
  if(currentStage===null||currentStage===undefined) return false;
  if(row.planned_stage===null||row.planned_stage===undefined) return false;
  if(row.gate_status === 'reviewed') return false;
  return Number(currentStage) > Number(row.planned_stage);
}
async function loadDeliverable(did){ const r = await pool.query(`SELECT * FROM design_deliverables WHERE id=$1 LIMIT 1`, [did]); return r.rows[0]||null; }
function canEdit(user, ownerOrgId){ return user.role==='consultant' || (!!ownerOrgId && ownerOrgId===user.tenantId); }
function actorName(u){ return u.name || u.email || 'user'; }
async function revisionOk(revisionId, projectId){
  if(!revisionId) return true;
  const r = await pool.query(`SELECT 1 FROM document_revisions rv JOIN documents d ON d.id=rv.document_id WHERE rv.id=$1 AND d.project_id=$2 LIMIT 1`, [revisionId, projectId]);
  return r.rows.length>0;
}

function shape(row, user, currentStage){
  const mine = user.role==='consultant' || row.org_id===user.tenantId;
  const evidence = row.revision_id ? {
    revisionId: row.revision_id, documentId: row.rev_document_id||null,
    name: (row.rev_doc_ref?row.rev_doc_ref+' ':'') + (row.rev_doc_title||'') + (row.rev_label?' · '+row.rev_label:''),
    link: row.rev_link||null,
  } : null;
  return {
    id: row.id, orgId: row.org_id, orgName: row.org_name, title: row.title, discipline: row.discipline,
    plannedStage: row.planned_stage, plannedStageName: stageName(row.planned_stage),
    complianceCritical: !!row.compliance_critical, currentRevision: row.current_revision, externalUrl: row.external_url,
    gateStatus: row.gate_status || 'not_submitted', gateStatusLabel: GATE_LABEL[row.gate_status||'not_submitted'],
    gateRevision: row.gate_revision, gateStage: row.gate_stage, gateStageName: stageName(row.gate_stage),
    reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, reviewNote: row.review_note,
    evidence, notes: row.notes, overdue: isOverdue(row, currentStage), canEdit: mine, updatedAt: row.updated_at,
  };
}

// GET
router.get('/projects/:id/deliverables', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error:'forbidden' });
    const pr = await pool.query(`SELECT riba_stage FROM projects WHERE id=$1 LIMIT 1`, [projectId]);
    if(!pr.rows.length) return res.status(404).json({ error:'project_not_found' });
    const currentStage = pr.rows[0].riba_stage;
    const r = await pool.query(
      `SELECT dd.*, t.name AS org_name,
              d.id AS rev_document_id, d.doc_ref AS rev_doc_ref, d.name AS rev_doc_title, rv.rev AS rev_label, rv.link AS rev_link
         FROM design_deliverables dd
         LEFT JOIN tenants t             ON t.id = dd.org_id
         LEFT JOIN document_revisions rv ON rv.id = dd.revision_id
         LEFT JOIN documents d           ON d.id = rv.document_id
        WHERE dd.project_id = $1
        ORDER BY dd.compliance_critical DESC, dd.discipline NULLS LAST, dd.created_at`,
      [projectId]
    );
    res.json({ deliverables: r.rows.map(row => shape(row, req.user, currentStage)), currentStage, wording: REVIEW_WORDING });
  } catch(err){ console.error('GET deliverables error:', err); res.status(500).json({ error:'server_error' }); }
});

// POST
router.post('/projects/:id/deliverables', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error:'forbidden' });
    const f = cleanBody(req.body||{});
    if(!f.title) return res.status(400).json({ error:'title_required' });
    if(!(await revisionOk(f.revision_id, projectId))) return res.status(400).json({ error:'revision_not_in_project' });
    const orgId = req.user.role==='consultant' ? (req.body?.orgId||null) : req.user.tenantId;
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO design_deliverables (id, project_id, org_id, title, discipline, planned_stage, compliance_critical, current_revision, external_url, revision_id, notes, gate_status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'not_submitted',$12,$12)`,
      [id, projectId, orgId, f.title, f.discipline, f.planned_stage, f.compliance_critical, f.current_revision, f.external_url, f.revision_id, f.notes, req.user.id]
    );
    res.json({ deliverable: { id } });
  } catch(err){ console.error('POST deliverable error:', err); res.status(500).json({ error:'server_error' }); }
});

// PATCH — edit fields (not the gate; that is submit/review)
router.patch('/deliverables/:did', requireAuth, async (req, res) => {
  try {
    const cur = await loadDeliverable(req.params.did);
    if(!cur) return res.status(404).json({ error:'deliverable_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error:'forbidden' });
    const f = cleanBody(req.body||{}, cur);
    if(!f.title) return res.status(400).json({ error:'title_required' });
    if(!(await revisionOk(f.revision_id, cur.project_id))) return res.status(400).json({ error:'revision_not_in_project' });
    let orgId = cur.org_id;
    if(req.user.role==='consultant' && req.body?.orgId!==undefined) orgId = req.body.orgId||null;
    await pool.query(
      `UPDATE design_deliverables SET org_id=$1, title=$2, discipline=$3, planned_stage=$4, compliance_critical=$5,
              current_revision=$6, external_url=$7, revision_id=$8, notes=$9, updated_at=NOW(), updated_by=$10
        WHERE id=$11`,
      [orgId, f.title, f.discipline, f.planned_stage, f.compliance_critical, f.current_revision, f.external_url, f.revision_id, f.notes, req.user.id, req.params.did]
    );
    res.json({ deliverable: { id: req.params.did } });
  } catch(err){ console.error('PATCH deliverable error:', err); res.status(500).json({ error:'server_error' }); }
});

// SUBMIT for gate review (owner org or consultant)
router.post('/deliverables/:did/submit', requireAuth, async (req, res) => {
  try {
    const cur = await loadDeliverable(req.params.did);
    if(!cur) return res.status(404).json({ error:'deliverable_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error:'forbidden' });
    const revision = req.body?.revision !== undefined ? (str(req.body.revision,60)||cur.current_revision||null) : (cur.current_revision||null);
    const stage = req.body?.stage !== undefined ? stageOf(req.body.stage) : (cur.planned_stage ?? null);
    await pool.query(
      `UPDATE design_deliverables SET gate_status='submitted', gate_revision=$1, gate_stage=$2,
              reviewed_by=NULL, reviewed_by_id=NULL, reviewed_at=NULL, review_note=NULL,
              updated_at=NOW(), updated_by=$3 WHERE id=$4`,
      [revision, stage, req.user.id, req.params.did]
    );
    res.json({ deliverable: { id: req.params.did, gateStatus:'submitted' } });
  } catch(err){ console.error('submit deliverable error:', err); res.status(500).json({ error:'server_error' }); }
});

// REVIEW at the gate (consultant): reviewed (suitable) / returned (with reasons)
router.post('/deliverables/:did/review', requireAuth, requireConsultant, async (req, res) => {
  const action = String(req.body?.action||'').trim();
  if(!['reviewed','returned'].includes(action)) return res.status(400).json({ error:'invalid_action' });
  const note = req.body?.note !== undefined ? String(req.body.note).trim() : '';
  if(action==='returned' && !note) return res.status(400).json({ error:'return_note_required' });
  try {
    const cur = await loadDeliverable(req.params.did);
    if(!cur) return res.status(404).json({ error:'deliverable_not_found' });
    await pool.query(
      `UPDATE design_deliverables SET gate_status=$1, review_note=$2, reviewed_by=$3, reviewed_by_id=$4,
              reviewed_at=NOW(), updated_at=NOW(), updated_by=$4 WHERE id=$5`,
      [action, note||null, actorName(req.user), req.user.id, req.params.did]
    );
    res.json({ deliverable: { id: req.params.did, gateStatus: action }, wording: REVIEW_WORDING });
  } catch(err){ console.error('review deliverable error:', err); res.status(500).json({ error:'server_error' }); }
});

// REOPEN to not_submitted (consultant)
router.post('/deliverables/:did/reopen', requireAuth, requireConsultant, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE design_deliverables SET gate_status='not_submitted', gate_revision=NULL, gate_stage=NULL,
              reviewed_by=NULL, reviewed_by_id=NULL, reviewed_at=NULL, review_note=NULL, updated_at=NOW(), updated_by=$1
        WHERE id=$2 RETURNING id`, [req.user.id, req.params.did]);
    if(!r.rows.length) return res.status(404).json({ error:'deliverable_not_found' });
    res.json({ deliverable: { id: req.params.did, gateStatus:'not_submitted' } });
  } catch(err){ console.error('reopen deliverable error:', err); res.status(500).json({ error:'server_error' }); }
});

// SEED the standard default deliverables (consultant) — only when the register
// is empty, so it is never destructive. Editable afterwards like any row.
router.post('/projects/:id/deliverables/seed-defaults', requireAuth, requireConsultant, async (req, res) => {
  const projectId = req.params.id;
  try {
    const ex = await pool.query(`SELECT COUNT(*)::int AS n FROM design_deliverables WHERE project_id=$1`, [projectId]);
    if(ex.rows[0].n > 0) return res.status(409).json({ error: 'register_not_empty' });
    for(const d of DEFAULT_DELIVERABLES){
      await pool.query(
        `INSERT INTO design_deliverables (id, project_id, org_id, title, discipline, planned_stage, compliance_critical, gate_status, created_by, updated_by)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,'not_submitted',$7,$7)`,
        [crypto.randomUUID(), projectId, d.title, d.discipline, d.stage, !!d.critical, req.user.id]
      );
    }
    res.json({ ok:true, added: DEFAULT_DELIVERABLES.length });
  } catch(err){ console.error('seed-defaults error:', err); res.status(500).json({ error:'server_error' }); }
});

// DELETE
router.delete('/deliverables/:did', requireAuth, async (req, res) => {
  try {
    const cur = await loadDeliverable(req.params.did);
    if(!cur) return res.status(404).json({ error:'deliverable_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error:'forbidden' });
    await pool.query(`DELETE FROM design_deliverables WHERE id=$1`, [req.params.did]);
    res.json({ ok:true });
  } catch(err){ console.error('DELETE deliverable error:', err); res.status(500).json({ error:'server_error' }); }
});

module.exports = { router };
