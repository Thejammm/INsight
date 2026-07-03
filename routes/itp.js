// ══════════════════════════════════════════════════════════════
//  Inspection & Test Plan — tiered assurance model (Round 2 Part A2).
//  Mounted at /api:
//    GET/POST   /api/projects/:id/itp
//    PATCH/DEL  /api/itp/:iid
//    POST       /api/itp/:iid/samples                add a surveillance sample
//    POST       /api/itp/samples/:sid/review-benchmark   (consultant) approve benchmark
//    DELETE     /api/itp/samples/:sid
//    POST       /api/itp/:iid/escalation/clear       (consultant) de-escalate
//
//  Each line carries a verification TIER:
//    hold        — work stops until verified (status pass/fail, unchanged)
//    witness     — reviewer notified (date/who) then verified (status)
//    surveillance— high-volume sampling: population, target %, benchmark that must
//                  be Reviewed before samples, live coverage, escalation on fails
//    self_cert   — contractor records are the evidence (records link + audits)
//  InSight holds the REGIME and the EVIDENCE it was followed — not an inspection
//  diary. Overdue / failed / behind-target are QUALITY flags (separate RAG).
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireConsultant } = require('../middleware/auth');
const { userCanAccessProject } = require('./projects');
const { stageName } = require('../db/ribaStages');

const router = express.Router();
const TIERS = ['hold', 'witness', 'surveillance', 'self_cert'];
const STATUSES = ['planned', 'in_progress', 'passed', 'failed', 'na'];
const DONE = { passed: true, na: true };

const str = (v, max) => v === undefined || v === null ? undefined : String(v).trim().slice(0, max);
const numOrNull = (v) => { if(v===undefined||v===null||v==='') return null; const n=Number(v); return Number.isFinite(n)?n:null; };
function stageOf(v){ if(v===undefined||v===null||v==='') return null; const n=parseInt(v,10); return (Number.isNaN(n)||n<0||n>7)?null:n; }
function actorName(u){ return u.name || u.email || 'user'; }

function cleanBody(body, cur){
  cur = cur || {};
  const out = {
    section:   body.section   !== undefined ? (str(body.section, 120)||null)  : cur.section,
    title:     body.title     !== undefined ? str(body.title, 300)            : cur.title,
    reference: body.reference !== undefined ? (str(body.reference, 300)||null): cur.reference,
    notes:     body.notes     !== undefined ? (str(body.notes, 500)||null)    : cur.notes,
    status:    body.status    !== undefined ? (STATUSES.includes(body.status)?body.status:(cur.status||'planned')) : (cur.status||'planned'),
    tier:      body.tier      !== undefined ? (TIERS.includes(body.tier)?body.tier:(cur.tier||'hold')) : (cur.tier||'hold'),
    records_link:  body.recordsLink  !== undefined ? (str(body.recordsLink,1000)||null) : cur.records_link,
    notified_date: body.notifiedDate !== undefined ? (str(body.notifiedDate,20)||null)  : cur.notified_date,
    notified_who:  body.notifiedWho  !== undefined ? (str(body.notifiedWho,200)||null)  : cur.notified_who,
  };
  out.planned_stage = body.plannedStage !== undefined ? stageOf(body.plannedStage) : (cur.planned_stage ?? null);
  out.population = body.population !== undefined ? (numOrNull(body.population)===null?null:Math.max(0,Math.round(numOrNull(body.population)))) : (cur.population ?? null);
  if(body.targetPct !== undefined){
    const t = numOrNull(body.targetPct); out.target_pct = t===null?null:Math.max(0,Math.min(100,t)); out.base_target_pct = out.target_pct;
  } else { out.target_pct = cur.target_pct ?? null; out.base_target_pct = cur.base_target_pct ?? null; }
  return out;
}
async function loadItem(iid){ const r = await pool.query(`SELECT * FROM itp_items WHERE id=$1 LIMIT 1`, [iid]); return r.rows[0]||null; }
async function loadSample(sid){ const r = await pool.query(`SELECT s.*, i.org_id, i.project_id AS item_project FROM itp_samples s JOIN itp_items i ON i.id=s.itp_item_id WHERE s.id=$1 LIMIT 1`, [sid]); return r.rows[0]||null; }
function canEdit(user, ownerOrgId){ return user.role==='consultant' || (!!ownerOrgId && ownerOrgId===user.tenantId); }
function asArr(v){ if(Array.isArray(v)) return v; if(typeof v==='string'){ try{ const j=JSON.parse(v); return Array.isArray(j)?j:[]; }catch(e){ return []; } } return []; }

function isOverdue(row, currentStage, extra){
  if(currentStage===null||currentStage===undefined) return false;
  if(row.planned_stage===null||row.planned_stage===undefined) return false;
  if(row.tier==='hold' || row.tier==='witness'){ if(DONE[row.status]) return false; }
  else { // surveillance / self-cert: done when benchmark approved and coverage meets target
    if(extra && extra.benchmarkDone && extra.coveragePct >= (row.target_pct||0)) return false;
  }
  return Number(currentStage) > Number(row.planned_stage);
}

function assurance(row, ext){
  if(row.tier==='hold' || row.tier==='witness'){
    return (row.tier==='hold'?'Hold point':'Witness point') + ' — ' + (DONE[row.status]?'verified':'awaiting verification') + (row.notified_date && row.tier==='witness'?', notified '+row.notified_date:'');
  }
  const pop = row.population || 0;
  const bench = ext.benchmarkDone ? ('benchmark approved '+(ext.benchmarkDate||'')) : 'benchmark not yet approved';
  const cov = pop ? (ext.coveragePct+'% of '+(row.target_pct||0)+'% target') : 'no population set';
  const ncr = ext.ncrOpen+ext.ncrClosed>0 ? (', '+(ext.ncrOpen+ext.ncrClosed)+' NCRs ('+ext.ncrClosed+' closed)') : '';
  const recs = row.records_link ? ', records linked' : ', no records link';
  return (row.tier==='surveillance'?'Surveillance':'Self-certification') + ' — population ' + (pop||'—') + ', ' + bench + ', sampled ' + cov + ncr + recs + (row.escalate_flag?' — ESCALATED':'');
}

async function shape(row, user, currentStage){
  const mine = user.role==='consultant' || row.org_id===user.tenantId;
  // samples + ncr counts (only needed for surveillance/self-cert; cheap enough always)
  const sres = await pool.query(`SELECT id, is_benchmark, result, ref, photos, note, reviewed_at, reviewed_by, created_at FROM itp_samples WHERE itp_item_id=$1 ORDER BY created_at`, [row.id]);
  const samples = sres.rows;
  const nonBench = samples.filter(s => !s.is_benchmark);
  const benchmark = samples.find(s => s.is_benchmark) || null;
  const benchmarkDone = !!(benchmark && benchmark.reviewed_at);
  const coveragePct = row.population ? Math.round(nonBench.length / row.population * 100) : 0;
  const nres = await pool.query(`SELECT status FROM ncrs WHERE itp_item_id=$1`, [row.id]);
  const ncrOpen = nres.rows.filter(n => n.status!=='closed').length;
  const ncrClosed = nres.rows.filter(n => n.status==='closed').length;
  const ext = { benchmarkDone, benchmarkDate: benchmark && benchmark.reviewed_at ? String(benchmark.reviewed_at).slice(0,10) : null, coveragePct, ncrOpen, ncrClosed, sampleCount: nonBench.length, failCount: nonBench.filter(s=>s.result==='fail').length };
  return {
    id: row.id, orgId: row.org_id, orgName: row.org_name, section: row.section, title: row.title, reference: row.reference,
    tier: row.tier, status: row.status, plannedStage: row.planned_stage, plannedStageName: stageName(row.planned_stage),
    population: row.population, targetPct: row.target_pct===null?null:Number(row.target_pct), baseTargetPct: row.base_target_pct===null?null:Number(row.base_target_pct),
    recordsLink: row.records_link, notifiedDate: row.notified_date, notifiedWho: row.notified_who,
    benchmarkReviewedAt: benchmark ? benchmark.reviewed_at : null, benchmarkDone,
    escFails: row.esc_fails, escWindow: row.esc_window, escStep: row.esc_step===null?null:Number(row.esc_step),
    escalateFlag: !!row.escalate_flag, escalationLog: asArr(row.escalation_log),
    coveragePct, sampleCount: ext.sampleCount, failCount: ext.failCount, ncrOpen, ncrClosed,
    samples: samples.map(s => ({ id:s.id, isBenchmark:s.is_benchmark, result:s.result, ref:s.ref, photos:asArr(s.photos), note:s.note, reviewedAt:s.reviewed_at, reviewedBy:s.reviewed_by, createdAt:s.created_at })),
    assurance: assurance(row, ext), overdue: isOverdue(row, currentStage, ext), failed: row.status==='failed',
    notes: row.notes, canEdit: mine, updatedAt: row.updated_at,
  };
}

// GET
router.get('/projects/:id/itp', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error:'forbidden' });
    const pr = await pool.query(`SELECT riba_stage FROM projects WHERE id=$1 LIMIT 1`, [projectId]);
    if(!pr.rows.length) return res.status(404).json({ error:'project_not_found' });
    const currentStage = pr.rows[0].riba_stage;
    const r = await pool.query(`SELECT it.*, t.name AS org_name FROM itp_items it LEFT JOIN tenants t ON t.id=it.org_id WHERE it.project_id=$1 ORDER BY it.section NULLS LAST, it.created_at`, [projectId]);
    const items = [];
    for(const row of r.rows) items.push(await shape(row, req.user, currentStage));
    res.json({ items, currentStage });
  } catch(err){ console.error('GET itp error:', err); res.status(500).json({ error:'server_error' }); }
});

// POST
router.post('/projects/:id/itp', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  try {
    if(!(await userCanAccessProject(req.user, projectId))) return res.status(403).json({ error:'forbidden' });
    const f = cleanBody(req.body||{});
    if(!f.title) return res.status(400).json({ error:'title_required' });
    const orgId = req.user.role==='consultant' ? (req.body?.orgId||null) : req.user.tenantId;
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO itp_items (id, project_id, org_id, section, title, reference, tier, planned_stage, status, population, target_pct, base_target_pct, records_link, notified_date, notified_who, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
      [id, projectId, orgId, f.section, f.title, f.reference, f.tier, f.planned_stage, f.status, f.population, f.target_pct, f.base_target_pct, f.records_link, f.notified_date, f.notified_who, f.notes, req.user.id]
    );
    res.json({ item: { id } });
  } catch(err){ console.error('POST itp error:', err); res.status(500).json({ error:'server_error' }); }
});

// PATCH
router.patch('/itp/:iid', requireAuth, async (req, res) => {
  try {
    const cur = await loadItem(req.params.iid);
    if(!cur) return res.status(404).json({ error:'itp_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error:'forbidden' });
    const f = cleanBody(req.body||{}, cur);
    if(!f.title) return res.status(400).json({ error:'title_required' });
    let orgId = cur.org_id;
    if(req.user.role==='consultant' && req.body?.orgId!==undefined) orgId = req.body.orgId||null;
    await pool.query(
      `UPDATE itp_items SET org_id=$1, section=$2, title=$3, reference=$4, tier=$5, planned_stage=$6, status=$7,
              population=$8, target_pct=$9, base_target_pct=$10, records_link=$11, notified_date=$12, notified_who=$13, notes=$14,
              updated_at=NOW(), updated_by=$15 WHERE id=$16`,
      [orgId, f.section, f.title, f.reference, f.tier, f.planned_stage, f.status, f.population, f.target_pct, f.base_target_pct, f.records_link, f.notified_date, f.notified_who, f.notes, req.user.id, req.params.iid]
    );
    res.json({ item: { id: req.params.iid } });
  } catch(err){ console.error('PATCH itp error:', err); res.status(500).json({ error:'server_error' }); }
});

// DELETE
router.delete('/itp/:iid', requireAuth, async (req, res) => {
  try {
    const cur = await loadItem(req.params.iid);
    if(!cur) return res.status(404).json({ error:'itp_not_found' });
    if(!canEdit(req.user, cur.org_id)) return res.status(403).json({ error:'forbidden' });
    await pool.query(`DELETE FROM itp_items WHERE id=$1`, [req.params.iid]);
    res.json({ ok:true });
  } catch(err){ console.error('DELETE itp error:', err); res.status(500).json({ error:'server_error' }); }
});

// ── Surveillance samples ────────────────────────────────────────
// Add a sample. Benchmark-then-sample is enforced: a non-benchmark sample is
// refused until a benchmark sample exists AND has been Reviewed. A failing
// sample runs the escalation rule.
router.post('/itp/:iid/samples', requireAuth, async (req, res) => {
  try {
    const item = await loadItem(req.params.iid);
    if(!item) return res.status(404).json({ error:'itp_not_found' });
    if(!canEdit(req.user, item.org_id)) return res.status(403).json({ error:'forbidden' });
    const isBenchmark = !!req.body?.isBenchmark;
    const result = ['pass','fail'].includes(req.body?.result) ? req.body.result : 'pass';
    const ref = str(req.body?.ref, 200) || null;
    const note = str(req.body?.note, 500) || null;
    const photos = Array.isArray(req.body?.photos) ? req.body.photos.map(x => String(x).slice(0,1000)).slice(0,20) : [];
    const existing = await pool.query(`SELECT is_benchmark, reviewed_at, result FROM itp_samples WHERE itp_item_id=$1`, [req.params.iid]);
    const benchmark = existing.rows.find(s => s.is_benchmark);
    if(isBenchmark && benchmark) return res.status(409).json({ error:'benchmark_exists' });
    if(!isBenchmark && !(benchmark && benchmark.reviewed_at)) return res.status(409).json({ error:'benchmark_required' });
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO itp_samples (id, itp_item_id, project_id, is_benchmark, result, ref, photos, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [id, req.params.iid, item.project_id, isBenchmark, result, ref, JSON.stringify(photos), note, req.user.id]
    );
    // Escalation rule (only on non-benchmark fails; data-driven; idempotent flag).
    let escalated = false;
    if(!isBenchmark && result==='fail' && !item.escalate_flag){
      const win = item.esc_window || 20, need = item.esc_fails || 2, step = Number(item.esc_step)||2;
      const recent = await pool.query(`SELECT result FROM itp_samples WHERE itp_item_id=$1 AND is_benchmark=FALSE ORDER BY created_at DESC LIMIT $2`, [req.params.iid, win]);
      const fails = recent.rows.filter(r => r.result==='fail').length;
      if(fails >= need){
        const base = item.base_target_pct!==null && item.base_target_pct!==undefined ? Number(item.base_target_pct) : (Number(item.target_pct)||0);
        const raised = Math.min(100, base * step);
        const log = asArr(item.escalation_log);
        log.push({ type:'escalate', date:new Date().toISOString(), by:actorName(req.user), fails, window:win, from:base, to:raised });
        await pool.query(`UPDATE itp_items SET escalate_flag=TRUE, target_pct=$1, escalation_log=$2::jsonb, updated_at=NOW(), updated_by=$3 WHERE id=$4`,
          [raised, JSON.stringify(log), req.user.id, req.params.iid]);
        escalated = true;
      }
    }
    res.json({ sample: { id }, escalated });
  } catch(err){ console.error('add sample error:', err); res.status(500).json({ error:'server_error' }); }
});

// Approve the benchmark (consultant) — unlocks bulk sampling.
router.post('/itp/samples/:sid/review-benchmark', requireAuth, requireConsultant, async (req, res) => {
  try {
    const s = await loadSample(req.params.sid);
    if(!s) return res.status(404).json({ error:'sample_not_found' });
    if(!s.is_benchmark) return res.status(400).json({ error:'not_a_benchmark' });
    await pool.query(`UPDATE itp_samples SET reviewed_at=NOW(), reviewed_by=$1 WHERE id=$2`, [actorName(req.user), req.params.sid]);
    res.json({ ok:true });
  } catch(err){ console.error('review-benchmark error:', err); res.status(500).json({ error:'server_error' }); }
});

router.delete('/itp/samples/:sid', requireAuth, async (req, res) => {
  try {
    const s = await loadSample(req.params.sid);
    if(!s) return res.status(404).json({ error:'sample_not_found' });
    if(!canEdit(req.user, s.org_id)) return res.status(403).json({ error:'forbidden' });
    await pool.query(`DELETE FROM itp_samples WHERE id=$1`, [req.params.sid]);
    res.json({ ok:true });
  } catch(err){ console.error('delete sample error:', err); res.status(500).json({ error:'server_error' }); }
});

// Clear the escalation flag (consultant only) — an attributed de-escalation.
router.post('/itp/:iid/escalation/clear', requireAuth, requireConsultant, async (req, res) => {
  try {
    const item = await loadItem(req.params.iid);
    if(!item) return res.status(404).json({ error:'itp_not_found' });
    const base = item.base_target_pct!==null && item.base_target_pct!==undefined ? Number(item.base_target_pct) : (Number(item.target_pct)||0);
    const log = asArr(item.escalation_log);
    log.push({ type:'clear', date:new Date().toISOString(), by:actorName(req.user), restoredTo:base });
    await pool.query(`UPDATE itp_items SET escalate_flag=FALSE, target_pct=$1, escalation_log=$2::jsonb, updated_at=NOW(), updated_by=$3 WHERE id=$4`,
      [base, JSON.stringify(log), req.user.id, req.params.iid]);
    res.json({ ok:true });
  } catch(err){ console.error('clear escalation error:', err); res.status(500).json({ error:'server_error' }); }
});

module.exports = { router };
