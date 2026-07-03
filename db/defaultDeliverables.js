// ══════════════════════════════════════════════════════════════
//  Default design-deliverables list (Round 2 Part A1). A sensible standard set
//  for a typical building project, applied on request (never auto-forced) and
//  fully editable afterwards — this is editable DATA, not baked-in logic.
//  compliance_critical marks the deliverables that weight the dashboard/reports.
//  stage = the RIBA stage the deliverable is required by.
//
//  ⚠️ DRAFT pending Simon's content verification (same stop-and-present rule as
//  all seeded content). Adjust freely; nothing here is a legal citation.
// ══════════════════════════════════════════════════════════════
const DEFAULT_DELIVERABLES = [
  { title: 'Design risk register (residual risk information)', discipline: 'Principal designer', stage: 2, critical: true  },
  { title: 'Design and access statement',                      discipline: 'Architectural',       stage: 2, critical: false },
  { title: 'Concept design',                                   discipline: 'Architectural',       stage: 2, critical: false },
  { title: 'Fire strategy',                                    discipline: 'Fire',                stage: 3, critical: true  },
  { title: 'Pre-construction information',                     discipline: 'Principal designer',  stage: 3, critical: true  },
  { title: 'Structural design and calculations',              discipline: 'Structural',          stage: 4, critical: true  },
  { title: 'Building services (MEP) design',                   discipline: 'MEP',                 stage: 4, critical: false },
  { title: 'Technical design drawing package',                 discipline: 'Architectural',       stage: 4, critical: false },
  { title: 'Specifications',                                   discipline: 'Architectural',       stage: 4, critical: false },
  { title: 'Health and safety file information',               discipline: 'Principal designer',  stage: 6, critical: true  },
];

module.exports = { DEFAULT_DELIVERABLES };
