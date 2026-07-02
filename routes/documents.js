// ══════════════════════════════════════════════════════════════
//  Document register (per project). Mounted at /api:
//    GET/POST  /api/projects/:id/documents
//    PATCH/DEL /api/documents/:did
//
//  Any participant on a project can see and add documents; editing / deleting a
//  document is limited to the organisation that added it, or the consultant.
//  Duty evidence links to these entries (see routes/projectDuties.js).
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');

const router = express.Router();
const STATUSES = ['current', 'draft', 'superseded', 'archived'];

function cleanFields(body, cur){
  cur = cur || {};
  const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);
  const out = {};
  out.name        = body.name        !== undefined ? str(body.name, 300)      : cur.name;
  out.category    = body.category    !== undefined ? (str(body.category, 120)   || null) : cur.category;
  out.version     = body.version     !== undefined ? (str(body.version, 60)     || null) : cur.version;
  out.owner       = body.owner       !== undefined ? (str(body.owner, 200)      || null) : cur.owner;
  out.link        = body.link        !== undefined ? (str(body.link, 1000)      || null) : cur.link;
  out.review_date = body.reviewDate  !== undefined ? (str(body.reviewDate, 10)  || null) : cur.review_date;
  out.status      = body.status      !== undefined
    ? (STATUSES.includes(body.status) ? body.status : (cur.status || 'current'))
    : (cur.status || 'current');
  return out;
}

async function loadDoc(did){
  const r = await pool.query(`SELECT * FROM documents WHERE id = $1 LIMIT 1`, [did]);
  return r.rows[0] || null;
}
function canEditDoc(user, doc){
  return user.role === 'consultant' || (!!doc.org_id && doc.org_id === user.tenantId);
}

// GET /api/projects/:id/documents — the project's register (access-checked)
router.get('/projects/:id/documents', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const r = await pool.query(
      `SELECT d.*, t.name AS org_name
         FROM documents d
         LEFT JOIN tenants t ON t.id = d.org_id
        WHERE d.project_id = $1
        ORDER BY d.created_at DESC`,
      [projectId]
    );
    res.json({ documents: r.rows });
  } catch(err){
    console.error('GET documents error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/projects/:id/documents — add an entry (any project participant)
router.post('/projects/:id/documents', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error: 'forbidden' });
    const f = cleanFields(req.body || {});
    if(!f.name) return res.status(400).json({ error: 'name_required' });
    const id = crypto.randomUUID();
    const orgId = req.user.role === 'consultant' ? (req.body?.orgId || null) : req.user.tenantId;
    const r = await pool.query(
      `INSERT INTO documents (id, project_id, org_id, name, category, version, owner, review_date, link, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
      [id, projectId, orgId, f.name, f.category, f.version, f.owner, f.review_date, f.link, f.status, req.user.id]
    );
    res.json({ document: r.rows[0] });
  } catch(err){
    console.error('POST documents error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/documents/:did — edit (owning org or consultant)
router.patch('/documents/:did', requireAuth, async (req, res) => {
  try {
    const doc = await loadDoc(req.params.did);
    if(!doc) return res.status(404).json({ error: 'document_not_found' });
    if(!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'forbidden' });
    const f = cleanFields(req.body || {}, doc);
    if(!f.name) return res.status(400).json({ error: 'name_required' });
    const r = await pool.query(
      `UPDATE documents SET name=$1, category=$2, version=$3, owner=$4, review_date=$5, link=$6, status=$7,
              updated_at=NOW(), updated_by=$8 WHERE id=$9 RETURNING *`,
      [f.name, f.category, f.version, f.owner, f.review_date, f.link, f.status, req.user.id, req.params.did]
    );
    res.json({ document: r.rows[0] });
  } catch(err){
    console.error('PATCH document error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/documents/:did — remove (owning org or consultant)
router.delete('/documents/:did', requireAuth, async (req, res) => {
  try {
    const doc = await loadDoc(req.params.did);
    if(!doc) return res.status(404).json({ error: 'document_not_found' });
    if(!canEditDoc(req.user, doc)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM documents WHERE id = $1`, [req.params.did]);
    res.json({ ok: true });
  } catch(err){
    console.error('DELETE document error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = { router };
