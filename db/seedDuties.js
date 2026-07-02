// ══════════════════════════════════════════════════════════════
//  Duty templates seed (Stage 4 Item 3)
//  The canonical dutyholder duties per role, in Simon's prototype wording.
//  Every citation below was verified verbatim against legislation.gov.uk on
//  2026-07-02 (CDM 2015 SI 2015/51 regulation/Part/Schedule headings; and the
//  Building Regulations 2010 Part 2A "Dutyholders and competence").
//  Seeded once into an empty duty_templates table; consultant edits are never
//  overwritten on redeploy. Duties are data, editable through the app.
// ══════════════════════════════════════════════════════════════
const DUTY_TEMPLATES = [
  { role: "client", seq: 1, regime: "cdm", citation: "CDM 2015, Reg 4", duty: "Make suitable arrangements for managing the project, with proportionate time and resources" },
  { role: "client", seq: 2, regime: "cdm", citation: "CDM 2015, Reg 4", duty: "Maintain and review the management arrangements throughout the project" },
  { role: "client", seq: 3, regime: "cdm", citation: "CDM 2015, Reg 4", duty: "Provide pre-construction information to every designer and contractor" },
  { role: "client", seq: 4, regime: "cdm", citation: "CDM 2015, Reg 4", duty: "Ensure a construction phase plan is in place before the construction phase begins" },
  { role: "client", seq: 5, regime: "cdm", citation: "CDM 2015, Reg 4", duty: "Ensure the health and safety file is prepared, kept available and revised" },
  { role: "client", seq: 6, regime: "cdm", citation: "CDM 2015, Reg 4", duty: "Take reasonable steps to ensure the principal designer and principal contractor comply with their duties" },
  { role: "client", seq: 7, regime: "cdm", citation: "CDM 2015, Reg 5", duty: "Appoint the principal designer and principal contractor in writing" },
  { role: "client", seq: 8, regime: "cdm", citation: "CDM 2015, Reg 6", duty: "Notify HSE on form F10 where the project is notifiable" },
  { role: "client", seq: 9, regime: "cdm", citation: "CDM 2015, Reg 8", duty: "Appoint only those with the skills, knowledge, experience and organisational capability" },
  { role: "client", seq: 10, regime: "cdm", citation: "CDM 2015, Sch 2", duty: "Ensure suitable welfare facilities are provided for the duration of the work" },
  { role: "designer", seq: 1, regime: "cdm", citation: "CDM 2015, Reg 9", duty: "Do not commence design work unless satisfied the client is aware of their duties" },
  { role: "designer", seq: 2, regime: "cdm", citation: "CDM 2015, Reg 9", duty: "Eliminate foreseeable health and safety risks through design, so far as reasonably practicable" },
  { role: "designer", seq: 3, regime: "cdm", citation: "CDM 2015, Reg 9", duty: "Reduce or control any remaining risks through design" },
  { role: "designer", seq: 4, regime: "cdm", citation: "CDM 2015, Reg 9", duty: "Provide information about remaining risks with the design" },
  { role: "designer", seq: 5, regime: "cdm", citation: "CDM 2015, Reg 8", duty: "Cooperate and coordinate with the client, principal designer and other designers" },
  { role: "principal_designer", seq: 1, regime: "cdm", citation: "CDM 2015, Reg 11", duty: "Plan, manage and monitor the pre-construction phase" },
  { role: "principal_designer", seq: 2, regime: "cdm", citation: "CDM 2015, Reg 11", duty: "Identify, eliminate or control foreseeable health and safety risks" },
  { role: "principal_designer", seq: 3, regime: "cdm", citation: "CDM 2015, Reg 11", duty: "Ensure designers cooperate, coordinate and comply with their duties" },
  { role: "principal_designer", seq: 4, regime: "cdm", citation: "CDM 2015, Reg 11", duty: "Assist the client in providing pre-construction information" },
  { role: "principal_designer", seq: 5, regime: "cdm", citation: "CDM 2015, Reg 11", duty: "Provide relevant information to designers and contractors" },
  { role: "principal_designer", seq: 6, regime: "cdm", citation: "CDM 2015, Reg 11", duty: "Liaise with the principal contractor and share information for the construction phase" },
  { role: "principal_designer", seq: 7, regime: "cdm", citation: "CDM 2015, Reg 12", duty: "Prepare the health and safety file" },
  { role: "principal_designer", seq: 8, regime: "cdm", citation: "CDM 2015, Reg 12", duty: "Review and update the health and safety file and pass it to the client at the end" },
  { role: "principal_contractor", seq: 1, regime: "cdm", citation: "CDM 2015, Reg 12", duty: "Draw up the construction phase plan before the site is set up" },
  { role: "principal_contractor", seq: 2, regime: "cdm", citation: "CDM 2015, Reg 13", duty: "Plan, manage and monitor the construction phase" },
  { role: "principal_contractor", seq: 3, regime: "cdm", citation: "CDM 2015, Reg 13", duty: "Organise cooperation between contractors and coordinate their work" },
  { role: "principal_contractor", seq: 4, regime: "cdm", citation: "CDM 2015, Reg 13", duty: "Ensure site inductions are given and take reasonable steps to prevent unauthorised access" },
  { role: "principal_contractor", seq: 5, regime: "cdm", citation: "CDM 2015, Reg 13", duty: "Ensure welfare facilities are provided throughout the construction phase" },
  { role: "principal_contractor", seq: 6, regime: "cdm", citation: "CDM 2015, Reg 14", duty: "Consult and engage with workers on health and safety" },
  { role: "principal_contractor", seq: 7, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Ensure safe places of work with safe access and egress" },
  { role: "principal_contractor", seq: 8, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Maintain good order and site security" },
  { role: "principal_contractor", seq: 9, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Ensure the stability of new and existing structures" },
  { role: "principal_contractor", seq: 10, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Plan demolition or dismantling to prevent danger" },
  { role: "principal_contractor", seq: 11, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Make excavations safe and prevent collapse" },
  { role: "principal_contractor", seq: 12, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Manage traffic routes and vehicles to separate people and plant" },
  { role: "principal_contractor", seq: 13, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Provide fire prevention, detection and fire-fighting arrangements" },
  { role: "principal_contractor", seq: 14, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Provide emergency procedures, routes and exits" },
  { role: "principal_contractor", seq: 15, regime: "cdm", citation: "CDM 2015, Part 4", duty: "Provide fresh air, reasonable temperature, weather protection and lighting" },
  { role: "contractor", seq: 1, regime: "cdm", citation: "CDM 2015, Reg 15", duty: "Do not carry out work unless satisfied the client is aware of their duties" },
  { role: "contractor", seq: 2, regime: "cdm", citation: "CDM 2015, Reg 15", duty: "Plan, manage and monitor their own work and that of their workers" },
  { role: "contractor", seq: 3, regime: "cdm", citation: "CDM 2015, Reg 15", duty: "Comply with directions given by the principal designer and principal contractor" },
  { role: "contractor", seq: 4, regime: "cdm", citation: "CDM 2015, Reg 15", duty: "Where the only contractor, ensure a construction phase plan is drawn up" },
  { role: "contractor", seq: 5, regime: "cdm", citation: "CDM 2015, Reg 15", duty: "Provide supervision, information, instruction and training to workers" },
  { role: "br_principal_designer", seq: 1, regime: "building_regs", citation: "Building Regulations 2010, Part 2A", duty: "Plan, manage and monitor the design work to ensure Building Regulations compliance" },
  { role: "br_principal_designer", seq: 2, regime: "building_regs", citation: "Building Regulations 2010, Part 2A", duty: "Coordinate the design so all designers meet the relevant requirements" },
  { role: "br_principal_designer", seq: 3, regime: "building_regs", citation: "Building Regulations 2010, Part 2A", duty: "Ensure designers cooperate with the principal designer and comply with their duties" },
  { role: "br_principal_designer", seq: 4, regime: "building_regs", citation: "Building Regulations 2010, Part 2A", duty: "Liaise with the principal contractor and share compliance information" },
  { role: "br_principal_designer", seq: 5, regime: "building_regs", citation: "Building Regulations 2010, Part 2A", duty: "Assist the client in meeting their Building Regulations duties" },
  { role: "br_principal_contractor", seq: 1, regime: "building_regs", citation: "Building Regulations 2010, Part 2A", duty: "Plan, manage and monitor the building work to ensure Building Regulations compliance" },
  { role: "br_principal_contractor", seq: 2, regime: "building_regs", citation: "Building Regulations 2010, Part 2A", duty: "Coordinate the work of contractors so the building work meets the relevant requirements" },
];

const { pool } = require('./index');

async function seedDutyTemplates(){
  const c = await pool.query('SELECT COUNT(*) AS n FROM duty_templates');
  if(Number(c.rows[0].n) > 0){ console.log('• Duty templates already present ('+c.rows[0].n+')'); return; }
  for(const d of DUTY_TEMPLATES){
    await pool.query(
      'INSERT INTO duty_templates (id, role, seq, regime, duty, citation) VALUES ($1,$2,$3,$4,$5,$6)',
      ['dt-'+d.role+'-'+d.seq, d.role, d.seq, d.regime, d.duty, d.citation]
    );
  }
  console.log('✓ Seeded '+DUTY_TEMPLATES.length+' duty templates');
}

module.exports = { DUTY_TEMPLATES, seedDutyTemplates };
