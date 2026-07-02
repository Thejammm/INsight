// ══════════════════════════════════════════════════════════════
//  /api/duty-templates — the canonical dutyholder duties per role
//
//  Any signed-in user can read the templates (they are the framework, not
//  client data). Only the consultant can add, edit or retire a duty — duties
//  are data, owned by AHS.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const { pool } = require('../db');
const { requireAuth, requireConsultant } = require('../middleware/auth');
const { ROLES } = require('./projects');

const router = express.Router();
const REGIMES = ['cdm', 'building_regs'];

// GET /api/duty-templates[?role=...][&all=1]
// Active duties only by default; consultants may pass all=1 to include retired.
router.get('/', requireAuth, async (req, res) => {
  const role = req.query?.role ? String(req.query.role) : null;
  const includeRetired = req.user.role === 'consultant' && String(req.query?.all || '') === '1';
  try {
    const where = [];
    const params = [];
    if(!includeRetired){ where.push('is_active = TRUE'); }
    if(role){ params.push(role); where.push('role = $' + params.length); }
    const sql = `SELECT id, role, seq, regime, duty, citation, is_active
                   FROM duty_templates
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY role, seq`;
    const r = await pool.query(sql, params);
    res.json({ dutyTemplates: r.rows });
  } catch(err){
    console.error('GET /duty-templates error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/duty-templates  (consultant) { role, duty, citation, regime?, seq? }
router.post('/', requireAuth, requireConsultant, async (req, res) => {
  const role     = String(req.body?.role || '').trim();
  const duty     = String(req.body?.duty || '').trim();
  const citation = String(req.body?.citation || '').trim();
  let regime     = String(req.body?.regime || 'cdm').trim();
  if(!ROLES.includes(role))   return res.status(400).json({ error: 'invalid_role' });
  if(!duty)                   return res.status(400).json({ error: 'duty_required' });
  if(!citation)               return res.status(400).json({ error: 'citation_required' });
  if(!REGIMES.includes(regime)) regime = 'cdm';
  try {
    // Append to the end of the role's list unless a seq is given.
    let seq = parseInt(req.body?.seq, 10);
    if(Number.isNaN(seq)){
      const m = await pool.query('SELECT COALESCE(MAX(seq), 0) AS mx FROM duty_templates WHERE role = $1', [role]);
      seq = Number(m.rows[0].mx) + 1;
    }
    const id = 'dt-' + role + '-' + Date.now();
    const r = await pool.query(
      `INSERT INTO duty_templates (id, role, seq, regime, duty, citation, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, role, seq, regime, duty, citation, is_active`,
      [id, role, seq, regime, duty, citation, req.user.id]
    );
    res.json({ dutyTemplate: r.rows[0] });
  } catch(err){
    console.error('POST /duty-templates error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/duty-templates/:id  (consultant) { duty?, citation?, regime?, seq?, isActive? }
router.patch('/:id', requireAuth, requireConsultant, async (req, res) => {
  const id = req.params.id;
  try {
    const cur = await pool.query('SELECT * FROM duty_templates WHERE id = $1 LIMIT 1', [id]);
    if(!cur.rows.length) return res.status(404).json({ error: 'duty_not_found' });
    const c = cur.rows[0];

    const duty     = req.body?.duty     !== undefined ? String(req.body.duty).trim()     : c.duty;
    const citation = req.body?.citation !== undefined ? String(req.body.citation).trim() : c.citation;
    if(!duty)     return res.status(400).json({ error: 'duty_required' });
    if(!citation) return res.status(400).json({ error: 'citation_required' });
    let regime = c.regime;
    if(req.body?.regime !== undefined) regime = REGIMES.includes(req.body.regime) ? req.body.regime : c.regime;
    let seq = c.seq;
    if(req.body?.seq !== undefined){ const n = parseInt(req.body.seq, 10); if(!Number.isNaN(n)) seq = n; }
    let isActive = c.is_active;
    if(typeof req.body?.isActive === 'boolean') isActive = req.body.isActive;

    const r = await pool.query(
      `UPDATE duty_templates
          SET duty = $1, citation = $2, regime = $3, seq = $4, is_active = $5,
              updated_at = NOW(), updated_by = $6
        WHERE id = $7
        RETURNING id, role, seq, regime, duty, citation, is_active`,
      [duty, citation, regime, seq, isActive, req.user.id, id]
    );
    res.json({ dutyTemplate: r.rows[0] });
  } catch(err){
    console.error('PATCH /duty-templates/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/duty-templates/:id  (consultant) — soft retire (is_active = false),
// so nothing is lost and it can be brought back.
router.delete('/:id', requireAuth, requireConsultant, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE duty_templates SET is_active = FALSE, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    if(r.rowCount === 0) return res.status(404).json({ error: 'duty_not_found' });
    res.json({ ok: true });
  } catch(err){
    console.error('DELETE /duty-templates/:id error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = { router };
