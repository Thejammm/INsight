// ══════════════════════════════════════════════════════════════
//  Seed the default planned RIBA stage onto each duty template (Round 1 Item 5).
//  Idempotent: only fills templates whose planned_stage is still NULL, so a
//  consultant's later edits are never overwritten on redeploy.
//
//  NOTE (matches seedDuties / seedGuidance): this requires ./index for its OWN
//  pool and takes no argument, because server.js does not import pool. Calling
//  seedStages(pool) would crash at startup.
// ══════════════════════════════════════════════════════════════
const { pool } = require('./index');
const { ROLE_STAGE } = require('./ribaStages');

async function seedStages(){
  let n = 0;
  for(const role of Object.keys(ROLE_STAGE)){
    const r = await pool.query(
      `UPDATE duty_templates SET planned_stage = $1
        WHERE role = $2 AND planned_stage IS NULL`,
      [ROLE_STAGE[role], role]
    );
    n += r.rowCount;
  }
  console.log('✓ Duty planned RIBA stages seeded into ' + n + ' templates');
}

module.exports = { seedStages };
