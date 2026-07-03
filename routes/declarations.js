// ══════════════════════════════════════════════════════════════
//  Declarations register (Stage 5 Item 5). Mounted at /api:
//    GET/POST   /api/projects/:id/declarations
//    PATCH/DEL  /api/declarations/:did
//
//  A high-level checklist that required declarations (e.g. Building Regs 2010
//  Part 2A dutyholder competence declarations) are in place. The app holds NO
//  declaration content — each row references the stored file via a document-
//  library revision (its filename + link) and records only whether it has been
//  provided. The GET returns a `gate` summary (all required provided?).
//  Any project participant may see and add; editing/deleting is limited to the
//  organisation the declaration is for, or the consultant.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');

const router = express.Router();
const STATUSES = ['outstanding', 'provided', 'na'];

const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);

function cleanBody(body, cur){
  cur = cur || {};
  return {
    title:       body.title      !== undefined ? str(body.title, 300)             : cur.title,
    status:      body.status     !== undefined ? (STATUSES.includes(body.status) ? body.status : (cur.status || 'outstanding')) : (cur.status || 'outstanding'),
    revision_id: body.revisionId !== undefined ? (str(body.revisionId, 60) || null) : cur.revision_id,
    notes:       body.notes      !== undefined ? (str(body.notes, 500) || null)   : cur.notes,
  };
}

async function loadDec(did){ const r = await pool.query(`SELECT * FROM declarations WHERE id = $1 LIMIT 1`, [did]); return r.rows[0] || null; }
function canEdit(user, ownerOrgId){ return user.role === 'consultant' || (!!ownerOrgId && ownerOrgId === user.tenantId); }
async function revisionOk(revisionId, projectId){
  if(!revisionId) return true;
  const r = await pool.query(
    `SELECT 1 FROM document_revisions rv JOIN documents d ON d.id = rv.document_id
      WHERE rv.id = $1 AND d.project_id = $2 LIMIT 1`, [revisionId, projectId]);
  return r.rows.length > 0;
}

// GET /api/projects/:id/declarations
router.get('/projects/:id/declarations', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const r = await pool.query(
      `SELECT dc.*, t.name AS org_name,
              d.id AS rev_document_id, d.doc_ref AS rev_doc_ref, d.name AS rev_doc_title, rv.rev AS rev_label, rv.link AS rev_link
         FROM declarations dc
         LEFT JOIN tenants t             ON t.id = dc.org_id
         LEFT JOIN document_revisions rv ON rv.id = dc.revision_id
         LEFT JOIN documents d           ON d.id = rv.document_id
        WHERE dc.project_id = $1
        ORDER BY CASE WHEN dc.status = 'provided' THEN 1 ELSE 0 END, dc.created_at`,
      [projectId]
    );
    const declarations = r.rows.map(row => {
      const mine = req.user.role === 'consultant' || row.org_id === req.user.tenantId;
      const file = row.revision_id ? {
        revisionId: row.revision_id,
        documentId: row.rev_document_id || null,
        name: (row.rev_doc_ref ? row.rev_doc_ref + ' ' : '') + (row.rev_doc_title || '') + (row.rev_label ? ' · ' + row.rev_label : ''),
        link: row.rev_link || null,
      } : null;
      return {
        id: row.id, orgId: row.org_id, orgName: row.org_name, title: row.title,
        status: row.status, notes: row.notes, file, canEdit: mine,
      };
    });
    // Gate: every declaration that is required (not n/a) has been provided.
    const required = declarations.filter(d => d.status !== 'na');
    const provided = required.filter(d => d.status === 'provided');
    const gate = { required: required.length, provided: provided.length, passed: required.length > 0 && provided.length === required.length };
    res.json({ declarations, gate });
  } catch(err){ console.error('GET declarations error:', err); res.status(500).json({ error: 'server_error' }); }
});

// POST /api/projects/:id/declarations
router.post('/projects/:id/declarations', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {});
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, projectId))) return res.status(400).json({ error: 'revision_not_in_project' });
    const orgId = req.user.role === 'consultant' ? (req.body?.orgId || null) : req.user.tenantId;
    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO declarations (id, project_id, org_id, title, status, revision_id, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [id, projectId, orgId, f.title, f.status, f.revision_id, f.notes, req.user.id]
    );
    res.json({ declaration: { id: r.rows[0].id } });
  } catch(err){ console.error('POST declaration error:', err); res.status(500).json({ error: 'server_error' }); }
});

// PATCH /api/declarations/:did
router.patch('/declarations/:did', requireAuth, async (req, res) => {
  try {
    const cur = await loadDec(req.params.did);
    if(!cur) return res.status(404).json({ error: 'declaration_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanBody(req.body || {}, cur);
    if(!f.title) return res.status(400).json({ error: 'title_required' });
    if(!(await revisionOk(f.revision_id, cur.project_id))) return res.status(400).json({ error: 'revision_not_in_project' });
    let orgId = cur.org_id;
    if(req.user.role === 'consultant' && req.body?.orgId !== undefined) orgId = req.body.orgId || null;
    const r = await pool.query(
      `UPDATE declarations SET org_id=$1, title=$2, status=$3, revision_id=$4, notes=$5, updated_at=NOW(), updated_by=$6
        WHERE id=$7 RETURNING id`,
      [orgId, f.title, f.status, f.revision_id, f.notes, req.user.id, req.params.did]
    );
    res.json({ declaration: { id: r.rows[0].id } });
  } catch(err){ console.error('PATCH declaration error:', err); res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/declarations/:did
router.delete('/declarations/:did', requireAuth, async (req, res) => {
  try {
    const cur = await loadDec(req.params.did);
    if(!cur) return res.status(404).json({ error: 'declaration_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM declarations WHERE id = $1`, [req.params.did]);
    res.json({ ok: true });
  } catch(err){ console.error('DELETE declaration error:', err); res.status(500).json({ error: 'server_error' }); }
});

module.exports = { router };
