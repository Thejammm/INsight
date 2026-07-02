// ══════════════════════════════════════════════════════════════
//  /api/project-duties/:id/... — the duty review loop
//
//  - Recording a discharge method and attaching evidence: the appointed
//    organisation's own users, or the consultant.
//  - Reviewing (accept / return): the consultant only. Uses Simon's confirmed
//    wording; the review does not transfer the dutyholder's legal duty.
//  All actions carry attribution (who) and timestamps (when).
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireConsultant } = require('../middleware/auth');
const { REVIEW_WORDING, asEvidence } = require('./dutyStatus');

const router = express.Router();

function actorName(user){ return user.name || user.email || 'user'; }

// Load a duty with the org that owns it (via its appointment).
async function loadDuty(did){
  const r = await pool.query(
    `SELECT pd.*, a.org_id
       FROM project_duties pd
       JOIN appointments a ON a.id = pd.appointment_id
      WHERE pd.id = $1 LIMIT 1`,
    [did]
  );
  return r.rows[0] || null;
}
// May this user record discharge / evidence on this duty?
function canEditDuty(user, duty){
  return user.role === 'consultant' || (!!duty.org_id && duty.org_id === user.tenantId);
}

// ── Record how a duty will be discharged ────────────────────────
// PATCH /api/project-duties/:id  { discharge }
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const duty = await loadDuty(req.params.id);
    if(!duty) return res.status(404).json({ error: 'duty_not_found' });
    if(!canEditDuty(req.user, duty)) return res.status(403).json({ error: 'forbidden' });
    const discharge = req.body?.discharge !== undefined ? String(req.body.discharge).trim() : duty.discharge;
    const r = await pool.query(
      `UPDATE project_duties SET discharge = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3 RETURNING id, discharge`,
      [discharge || null, req.user.id, req.params.id]
    );
    res.json({ duty: r.rows[0] });
  } catch(err){
    console.error('PATCH /project-duties/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Attach evidence to a duty ───────────────────────────────────
// POST /api/project-duties/:id/evidence  { documentId }
// Evidence is a LINK to an entry in the project's document register — not a
// loose filename. The document must belong to the same project.
router.post('/:id/evidence', requireAuth, async (req, res) => {
  const documentId = String(req.body?.documentId || '').trim();
  if(!documentId) return res.status(400).json({ error: 'document_required' });
  try {
    const duty = await loadDuty(req.params.id);
    if(!duty) return res.status(404).json({ error: 'duty_not_found' });
    if(!canEditDuty(req.user, duty)) return res.status(403).json({ error: 'forbidden' });
    const dq = await pool.query(`SELECT id, name, category, project_id FROM documents WHERE id = $1 LIMIT 1`, [documentId]);
    if(!dq.rows.length || dq.rows[0].project_id !== duty.project_id){
      return res.status(400).json({ error: 'document_not_in_project' });
    }
    const docRow = dq.rows[0];
    const evidence = asEvidence(duty.evidence).slice();
    if(evidence.some(e => e.documentId === documentId)) return res.status(409).json({ error: 'already_linked' });
    evidence.push({
      documentId, name: docRow.name, category: docRow.category || null,
      addedBy: actorName(req.user), addedById: req.user.id, addedAt: new Date().toISOString()
    });
    const r = await pool.query(
      `UPDATE project_duties SET evidence = $1::jsonb, updated_at = NOW(), updated_by = $2 WHERE id = $3 RETURNING id, evidence`,
      [JSON.stringify(evidence), req.user.id, req.params.id]
    );
    res.json({ duty: r.rows[0] });
  } catch(err){
    console.error('POST /project-duties/:id/evidence error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/project-duties/:id/evidence/:idx — remove one evidence item
router.delete('/:id/evidence/:idx', requireAuth, async (req, res) => {
  try {
    const duty = await loadDuty(req.params.id);
    if(!duty) return res.status(404).json({ error: 'duty_not_found' });
    if(!canEditDuty(req.user, duty)) return res.status(403).json({ error: 'forbidden' });
    const evidence = asEvidence(duty.evidence).slice();
    const idx = parseInt(req.params.idx, 10);
    if(Number.isNaN(idx) || idx < 0 || idx >= evidence.length) return res.status(400).json({ error: 'bad_index' });
    evidence.splice(idx, 1);
    const r = await pool.query(
      `UPDATE project_duties SET evidence = $1::jsonb, updated_at = NOW(), updated_by = $2 WHERE id = $3 RETURNING id, evidence`,
      [JSON.stringify(evidence), req.user.id, req.params.id]
    );
    res.json({ duty: r.rows[0] });
  } catch(err){
    console.error('DELETE /project-duties/:id/evidence/:idx error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Review a duty (consultant only) ─────────────────────────────
// POST /api/project-duties/:id/review  { action: 'reviewed' | 'returned', note? }
//   reviewed → accepts it, using Simon's confirmed wording.
//   returned → sends it back; a note explaining what is needed is required.
router.post('/:id/review', requireAuth, requireConsultant, async (req, res) => {
  const action = String(req.body?.action || '').trim();
  if(!['reviewed','returned'].includes(action)) return res.status(400).json({ error: 'invalid_action' });
  const note = req.body?.note !== undefined ? String(req.body.note).trim() : '';
  if(action === 'returned' && !note) return res.status(400).json({ error: 'return_note_required' });
  try {
    const duty = await loadDuty(req.params.id);
    if(!duty) return res.status(404).json({ error: 'duty_not_found' });
    if(action === 'reviewed'){
      const evid = asEvidence(duty.evidence);
      if(!evid.length) return res.status(400).json({ error: 'no_evidence_to_review' });
    }
    const r = await pool.query(
      `UPDATE project_duties
          SET review_status = $1, review_note = $2, reviewed_by = $3, reviewed_by_id = $4,
              reviewed_at = NOW(), updated_at = NOW(), updated_by = $4
        WHERE id = $5
        RETURNING id, review_status, review_note, reviewed_by, reviewed_at`,
      [action, note || null, actorName(req.user), req.user.id, req.params.id]
    );
    res.json({ duty: r.rows[0], wording: REVIEW_WORDING });
  } catch(err){
    console.error('POST /project-duties/:id/review error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Reopen a reviewed/returned duty (consultant only) ───────────
// POST /api/project-duties/:id/reopen
router.post('/:id/reopen', requireAuth, requireConsultant, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE project_duties
          SET review_status = 'none', review_note = NULL, reviewed_by = NULL,
              reviewed_by_id = NULL, reviewed_at = NULL, updated_at = NOW(), updated_by = $1
        WHERE id = $2
        RETURNING id, review_status`,
      [req.user.id, req.params.id]
    );
    if(!r.rows.length) return res.status(404).json({ error: 'duty_not_found' });
    res.json({ duty: r.rows[0] });
  } catch(err){
    console.error('POST /project-duties/:id/reopen error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = { router };
