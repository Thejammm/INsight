// ══════════════════════════════════════════════════════════════
//  Round 2 Part A migration — move the Stage 5 quality data into the assurance
//  model. Idempotent: only touches rows not yet migrated (gate_status / tier
//  still NULL), so it is safe to run on every boot. Nothing is deleted.
//    - design_deliverables.status  -> gate_status
//        issued / accepted -> reviewed ; everything else -> not_submitted
//    - itp_items.control_point      -> tier
//        hold -> hold ; everything else -> witness  (per the prompt)
//  Requires ./index for its own pool, no argument (server.js has no pool).
// ══════════════════════════════════════════════════════════════
const { pool } = require('./index');

async function migrateQuality(){
  const d = await pool.query(
    `UPDATE design_deliverables
        SET gate_status = CASE WHEN status IN ('issued','accepted') THEN 'reviewed' ELSE 'not_submitted' END
      WHERE gate_status IS NULL`
  );
  const i = await pool.query(
    `UPDATE itp_items
        SET tier = CASE WHEN control_point = 'hold' THEN 'hold' ELSE 'witness' END
      WHERE tier IS NULL`
  );
  // Backfill the escalation restore-point where a target % exists but base doesn't.
  await pool.query(`UPDATE itp_items SET base_target_pct = target_pct WHERE base_target_pct IS NULL AND target_pct IS NOT NULL`);
  console.log('✓ Quality model migrated: ' + d.rowCount + ' deliverables, ' + i.rowCount + ' ITP lines');
}

module.exports = { migrateQuality };
