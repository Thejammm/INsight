// ══════════════════════════════════════════════════════════════
//  Document reference LIBRARY (per project). Mounted at /api:
//    GET/POST   /api/projects/:id/documents          (references + nested revisions)
//    PATCH/DEL  /api/documents/:did                  (a reference)
//    POST       /api/documents/:did/revisions        (add a revision)
//    PATCH/DEL  /api/revisions/:rid                  (a revision)
//
//  A document is a REFERENCE (a code + title), never an uploaded file — it points
//  to where the document lives. Controlled revisions hang off it. Duty evidence
//  points to a specific revision (see routes/projectDuties.js).
//  Any project participant can see and add; editing/deleting a reference (or its
//  revisions) is limited to the organisation that owns it, or the consultant.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');

const router = express.Router();
const REV_STATUSES = ['draft', 'for_review', 'approved', 'superseded', 'rejected'];

const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);

function cleanDoc(body, cur){
  cur = cur || {};
  return {
    doc_ref:  body.docRef   !== undefined ? (str(body.docRef, 80)   || null) : cur.doc_ref,
    name:     body.name     !== undefined ? str(body.name, 300)             : cur.name,     // title
    category: body.category !== undefined ? (str(body.category, 120) || null) : cur.category, // discipline
    owner:    body.owner    !== undefined ? (str(body.owner, 200)   || null) : cur.owner,
  };
}
function cleanRev(body, cur){
  cur = cur || {};
  return {
    rev:      body.rev     !== undefined ? str(body.rev, 40)               : cur.rev,
    status:   body.status  !== undefined ? (REV_STATUSES.includes(body.status) ? body.status : (cur.status||'draft')) : (cur.status||'draft'),
    rev_date: body.revDate !== undefined ? (str(body.revDate, 10) || null) : cur.rev_date,
    link:     body.link    !== undefined ? (str(body.link, 1000)  || null) : cur.link,
    notes:    body.notes   !== undefined ? (str(body.notes, 500)  || null) : cur.notes,
  };
}

async function loadDoc(did){ const r = await pool.query(`SELECT * FROM documents WHERE id = $1 LIMIT 1`, [did]); return r.rows[0] || null; }
async function loadRev(rid){
  const r = await pool.query(`SELECT rv.*, d.org_id, d.project_id FROM document_revisions rv JOIN documents d ON d.id = rv.document_id WHERE rv.id = $1 LIMIT 1`, [rid]);
  return r.rows[0] || null;
}
function canEdit(user, ownerOrgId){ return user.role === 'consultant' || (!!ownerOrgId && ownerOrgId === user.tenantId); }

// GET /api/projects/:id/documents — references with their revisions nested
router.get('/projects/:id/documents', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const dr = await pool.query(
      `SELECT d.*, t.name AS org_name FROM documents d LEFT JOIN tenants t ON t.id = d.org_id
        WHERE d.project_id = $1 ORDER BY d.doc_ref NULLS LAST, d.created_at DESC`,
      [projectId]
    );
    const docs = dr.rows;
    if(docs.length){
      const rv = await pool.query(
        `SELECT * FROM document_revisions WHERE document_id IN (${docs.map((_,i)=>'$'+(i+1)).join(',')}) ORDER BY created_at`,
        docs.map(d => d.id)
      );
      const byDoc = {}; rv.rows.forEach(r => { (byDoc[r.document_id] = byDoc[r.document_id] || []).push(r); });
      docs.forEach(d => { d.revisions = byDoc[d.id] || []; });
    }
    res.json({ documents: docs });
  } catch(err){ console.error('GET documents error:', err); res.status(500).json({ error: 'server_error' }); }
});

// POST /api/projects/:id/documents — add a reference (any project participant)
router.post('/projects/:id/documents', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const f = cleanDoc(req.body || {});
    if(!f.name) return res.status(400).json({ error: 'title_required' });
    const id = crypto.randomUUID();
    const orgId = req.user.role === 'consultant' ? (req.body?.orgId || null) : req.user.tenantId;
    const r = await pool.query(
      `INSERT INTO documents (id, project_id, org_id, doc_ref, name, category, owner, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [id, projectId, orgId, f.doc_ref, f.name, f.category, f.owner, req.user.id]
    );
    const doc = r.rows[0]; doc.revisions = [];
    res.json({ document: doc });
  } catch(err){ console.error('POST documents error:', err); res.status(500).json({ error: 'server_error' }); }
});

// PATCH /api/documents/:did — edit a reference
router.patch('/documents/:did', requireAuth, async (req, res) => {
  try {
    const doc = await loadDoc(req.params.did);
    if(!doc) return res.status(404).json({ error: 'document_not_found' });
    if(!canEdit(req.user, doc.org_id)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanDoc(req.body || {}, doc);
    if(!f.name) return res.status(400).json({ error: 'title_required' });
    const r = await pool.query(
      `UPDATE documents SET doc_ref=$1, name=$2, category=$3, owner=$4, updated_at=NOW(), updated_by=$5 WHERE id=$6 RETURNING *`,
      [f.doc_ref, f.name, f.category, f.owner, req.user.id, req.params.did]
    );
    res.json({ document: r.rows[0] });
  } catch(err){ console.error('PATCH document error:', err); res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/documents/:did — remove a reference (cascades its revisions)
router.delete('/documents/:did', requireAuth, async (req, res) => {
  try {
    const doc = await loadDoc(req.params.did);
    if(!doc) return res.status(404).json({ error: 'document_not_found' });
    if(!canEdit(req.user, doc.org_id)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM documents WHERE id = $1`, [req.params.did]);
    res.json({ ok: true });
  } catch(err){ console.error('DELETE document error:', err); res.status(500).json({ error: 'server_error' }); }
});

// POST /api/documents/:did/revisions — add a revision to a reference
router.post('/documents/:did/revisions', requireAuth, async (req, res) => {
  try {
    const doc = await loadDoc(req.params.did);
    if(!doc) return res.status(404).json({ error: 'document_not_found' });
    if(!canEdit(req.user, doc.org_id)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanRev(req.body || {});
    if(!f.rev) return res.status(400).json({ error: 'rev_required' });
    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO document_revisions (id, document_id, rev, status, rev_date, link, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [id, req.params.did, f.rev, f.status, f.rev_date, f.link, f.notes, req.user.id]
    );
    res.json({ revision: r.rows[0] });
  } catch(err){
    if(err.code === '23505') return res.status(409).json({ error: 'revision_exists' });
    console.error('POST revision error:', err); res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/revisions/:rid — edit a revision
router.patch('/revisions/:rid', requireAuth, async (req, res) => {
  try {
    const rev = await loadRev(req.params.rid);
    if(!rev) return res.status(404).json({ error: 'revision_not_found' });
    if(!canEdit(req.user, rev.org_id)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanRev(req.body || {}, rev);
    if(!f.rev) return res.status(400).json({ error: 'rev_required' });
    const r = await pool.query(
      `UPDATE document_revisions SET rev=$1, status=$2, rev_date=$3, link=$4, notes=$5, updated_at=NOW(), updated_by=$6 WHERE id=$7 RETURNING *`,
      [f.rev, f.status, f.rev_date, f.link, f.notes, req.user.id, req.params.rid]
    );
    res.json({ revision: r.rows[0] });
  } catch(err){ console.error('PATCH revision error:', err); res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/revisions/:rid — remove a revision
router.delete('/revisions/:rid', requireAuth, async (req, res) => {
  try {
    const rev = await loadRev(req.params.rid);
    if(!rev) return res.status(404).json({ error: 'revision_not_found' });
    if(!canEdit(req.user, rev.org_id)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM document_revisions WHERE id = $1`, [req.params.rid]);
    res.json({ ok: true });
  } catch(err){ console.error('DELETE revision error:', err); res.status(500).json({ error: 'server_error' }); }
});

module.exports = { router };
