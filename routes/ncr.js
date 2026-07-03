// ══════════════════════════════════════════════════════════════
//  Non-conformance register (Stage 5 Item 3). Mounted at /api:
//    GET/POST   /api/projects/:id/ncrs
//    PATCH/DEL  /api/ncrs/:nid
//
//  An NCR records a quality non-conformance on a project: what is wrong, its
//  severity (minor / major), the responsible organisation, a corrective action,
//  and — when closed — evidence (a document-library revision). Status runs
//  open -> in_progress -> closed. Any project participant may see and add;
//  editing/deleting is limited to the responsible organisation, or the
//  consultant. A quality workflow, separate from the duty-holder compliance RAG.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');

const router = express.Router();
const SEVERITY = ['minor', 'major'];
const STATUSES = ['open', 'in_progress', 'closed'];

const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);

function cleanBody(body, cur){
  cur = cur || {};
  return {
    ncr_ref:     body.ncrRef      !== undefined ? (str(body.ncrRef, 80) || null)   : cur.ncr_ref,
    title:       body.title       !== undefined ? str(body.title, 300)             : cur.title,
    description: body.description !== undefined ? (str(body.description, 1000) || null) : cur.description,
    severity:    body.severity    !== undefined ? (SEVERITY.includes(body.severity) ? body.severity : (cur.severity || 'minor')) : (cur.severity || 'minor'),
    status:      body.status      !== undefined ? (STATUSES.includes(body.status) ? body.status : (cur.status || 'open')) : (cur.status || 'open'),
    corrective_action: body.correctiveAction !== undefined ? (str(body.correctiveAction, 1000) || null) : cur.corrective_action,
    source:      body.source      !== undefined ? (str(body.source, 300) || null)  : cur.source,
    revision_id: body.revisionId  !== undefined ? (str(body.revisionId, 60) || null) : cur.revision_id,
    notes:       body.notes       !== undefined ? (str(body.notes, 500) || null)   : cur.notes,
  };
}

async function loadNcr(nid){ const r = await pool.query(`SELECT * FROM ncrs WHERE id = $1 LIMIT 1`, [nid]); return r.rows[0] || null; }
function canEdit(user, ownerOrgId){ return user.role === 'consultant' || (!!ownerOrgId && ownerOrgId === user.tenantId); }
async function revisionOk(revisionId, projectId){
  if(!revisionId) return true;
  const r = await pool.query(
    `SELECT 1 FROM document_revisions rv JOIN documents d ON d.id = rv.document_id
      WHERE rv.id = $1 AND d.project_id = $2 LIMIT 1`, [revisionId, projectId]);
  return r.rows.length > 0;
}

// GET /api/projects/:id/ncrs
router.get('/projects/:id/ncrs', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const r = await pool.query(
      `SELECT n.*, t.name AS org_name,
              d.id AS rev_document_id, d.doc_ref AS rev_doc_ref, d.name AS rev_doc_title, rv.rev AS rev_label, rv.link AS rev_link
         FROM ncrs n
         LEFT JOIN tenants t             ON t.id = n.org_id
         LEFT JOIN document_revisions rv ON rv.id = n.revision_id
         LEFT JOIN documents d           ON d.id = rv.document_id
        WHERE n.project_id = $1
        ORDER BY CASE WHEN n.status = 'closed' THEN 1 ELSE 0 END,
                 CASE WHEN n.severity = 'major' THEN 0 ELSE 1 END,
                 n.created_at`,
      [projectId]
    );
    const ncrs = r.rows.map(row => {
      const mine = req.user.role === 'consultant' || row.org_id === req.user.tenantId;
      const evidence = row.revision_id ? {
        revisionId: row.revision_id,
        documentId: row.rev_document_id || null,
        name: (row.rev_doc_ref ? row.rev_doc_ref + ' ' : '') + (row.rev_doc_title || '') + (row.rev_label ? ' · ' + row.rev_label : ''),
        link: row.rev_link || null,
      } : null;
      return {
        id: row.id, orgId: row.org_id, orgName: row.org_name, ncrRef: row.ncr_ref,
        title: row.title, description: row.description, severity: row.severity, status: row.status,
        correctiveAction: row.corrective_action, source: row.source, notes: row.notes, evidence,
        open: row.status !== 'closed', canEdit: mine,
      };
    });
    res.json({ ncrs });
  } catch(err){ console.error('GET ncrs error:', err); res.status(500).json({ error: 'server_error' }); }
});

// POST /api/projects/:id/ncrs
router.post('/projects/:id/ncrs', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {});
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, projectId))) return res.status(400).json({ error: 'revision_not_in_project' });
    const orgId = req.user.role === 'consultant' ? (req.body?.orgId || null) : req.user.tenantId;
    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO ncrs (id, project_id, org_id, ncr_ref, title, description, severity, status, corrective_action, source, revision_id, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
      [id, projectId, orgId, f.ncr_ref, f.title, f.description, f.severity, f.status, f.corrective_action, f.source, f.revision_id, f.notes, req.user.id]
    );
    res.json({ ncr: { id: r.rows[0].id } });
  } catch(err){ console.error('POST ncr error:', err); res.status(500).json({ error: 'server_error' }); }
});

// PATCH /api/ncrs/:nid
router.patch('/ncrs/:nid', requireAuth, async (req, res) => {
  try {
    const cur = await loadNcr(req.params.nid);
    if(!cur) return res.status(404).json({ error: 'ncr_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {}, cur);
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, cur.project_id))) return res.status(400).json({ error: 'revision_not_in_project' });
    let orgId = cur.org_id;
    if(req.user.role === 'consultant' && req.body?.orgId !== undefined) orgId = req.body.orgId || null;
    const r = await pool.query(
      `UPDATE ncrs SET org_id=$1, ncr_ref=$2, title=$3, description=$4, severity=$5, status=$6, corrective_action=$7, source=$8, revision_id=$9, notes=$10, updated_at=NOW(), updated_by=$11
        WHERE id=$12 RETURNING id`,
      [orgId, f.ncr_ref, f.title, f.description, f.severity, f.status, f.corrective_action, f.source, f.revision_id, f.notes, req.user.id, req.params.nid]
    );
    res.json({ ncr: { id: r.rows[0].id } });
  } catch(err){ console.error('PATCH ncr error:', err); res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/ncrs/:nid
router.delete('/ncrs/:nid', requireAuth, async (req, res) => {
  try {
    const cur = await loadNcr(req.params.nid);
    if(!cur) return res.status(404).json({ error: 'ncr_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM ncrs WHERE id = $1`, [req.params.nid]);
    res.json({ ok: true });
  } catch(err){ console.error('DELETE ncr error:', err); res.status(500).json({ error: 'server_error' }); }
});

module.exports = { router };
