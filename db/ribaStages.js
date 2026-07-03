// ══════════════════════════════════════════════════════════════
//  RIBA Plan of Work 2020 stages, each with a short stage-appropriate CDM
//  narrative (from Simon's prototype). Static reference data; a project stores
//  only its current stage (projects.riba_stage) and optional per-stage dates
//  (projects.riba_dates). The regulation references below (Reg 9, CDM Part 4)
//  are verified in the duty seed.
// ══════════════════════════════════════════════════════════════
const RIBA_STAGES = [
  { n: 0, name: 'Strategic Definition',           cdm: 'Client establishes the brief; early CDM thinking.' },
  { n: 1, name: 'Preparation and Briefing',       cdm: 'Client appoints duty holders and checks competence; pre-construction information begun.' },
  { n: 2, name: 'Concept Design',                 cdm: 'Designers apply Reg 9 — eliminate and reduce risk in the concept.' },
  { n: 3, name: 'Spatial Coordination',           cdm: 'Principal designer coordinates design risk across the team.' },
  { n: 4, name: 'Technical Design',               cdm: 'Pre-construction information issued, F10 submitted where notifiable, construction phase plan accepted.' },
  { n: 5, name: 'Manufacturing and Construction', cdm: 'Principal contractor manages the site (CDM Part 4); golden-thread evidence captured.' },
  { n: 6, name: 'Handover',                       cdm: 'Health and safety file handed to the client; as-built information.' },
  { n: 7, name: 'Use',                            cdm: 'Health and safety file kept up to date; informs future works.' },
];

// Default planned RIBA stage per role — the stage by which that role's duties
// should ordinarily be discharged (Round 1 Item 5). Seeded onto the duty
// templates and editable per project per duty. Grounded in the CDM 2015 flow:
// the client sets arrangements and appoints early; pre-construction design work
// (principal designer / designers) completes by Technical Design; the principal
// contractor / contractors carry duties through Manufacturing and Construction.
const ROLE_STAGE = {
  client:                  1,   // Preparation and Briefing — appointments, competence, PCI
  principal_designer:      4,   // pre-construction coordination complete by Technical Design
  designer:                4,
  principal_contractor:    5,   // Manufacturing and Construction
  contractor:              5,
  br_principal_designer:   4,   // Building Regs PD — design/pre-construction
  br_principal_contractor: 5,   // Building Regs PC — construction
};

function stageName(n){
  if(n === null || n === undefined) return '';
  const s = RIBA_STAGES.filter(x => x.n === Number(n))[0];
  return s ? s.name : '';
}

module.exports = { RIBA_STAGES, ROLE_STAGE, stageName };
