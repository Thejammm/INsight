// ══════════════════════════════════════════════════════════════
//  Duty guidance seed (Round 1 Item 1) — "What is expected" popups.
//  Our own plain-English summaries, grounded in CDM 2015 and the CITB/CONIAC
//  CDM 2015 industry guidance series (and, for Building Regs roles, the
//  government's Building Regulations dutyholder and competence guidance). We
//  cite the regulation (the duty's citation) and refer to guidance by name; we
//  do NOT reproduce guidance text verbatim. Every regulation reference was
//  verified against legislation.gov.uk (2026-07-02).
//  Keyed by duty_templates.id (dt-<role>-<seq>). Seeded into empty guidance only.
// ══════════════════════════════════════════════════════════════
const GUIDANCE = {
  // ── Client (CDM 2015) — see the CITB CDM 2015 industry guidance for clients ──
  'dt-client-1':  { requires: 'Set up and resource the project so health and safety is managed throughout, in proportion to the risks: allow realistic time and budget, make clear who does what, and satisfy yourself the arrangements are working.', evidence: ['Project management / CDM arrangements document', 'Programme showing realistic durations', 'Records of resources and appointments', 'Minutes showing health and safety on the agenda'] },
  'dt-client-2':  { requires: 'Keep the management arrangements under review for the life of the project and update them when the project, the team or the risks change.', evidence: ['Dated review records', 'Revised arrangements document', 'Meeting minutes noting the review'] },
  'dt-client-3':  { requires: 'Gather and give every designer and contractor the pre-construction information they need (existing hazards, site constraints, asbestos, services), early enough to inform their design and planning.', evidence: ['Pre-construction information pack', 'Issue / transmittal record', 'Asbestos survey', 'Existing drawings and records provided'] },
  'dt-client-4':  { requires: 'Make sure a suitable construction phase plan is in place before the construction phase begins, and do not allow work to start on site without it.', evidence: ['The construction phase plan', 'Record of receiving and accepting it before start on site', 'Start-on-site authorisation'] },
  'dt-client-5':  { requires: 'For projects with more than one contractor, ensure the health and safety file is prepared, kept available, revised as needed and retained.', evidence: ['The health and safety file', 'Handover record', 'Retention / storage arrangement'] },
  'dt-client-6':  { requires: 'Take reasonable steps to satisfy yourself the principal designer and principal contractor are carrying out their duties. Do not appoint and forget.', evidence: ['Monitoring records', 'Review meeting minutes', 'Queries raised and the responses', 'A light-touch assurance log'] },
  'dt-client-7':  { requires: 'Where there is, or will be, more than one contractor, appoint a principal designer and a principal contractor in writing. If you do not, you take on their duties yourself.', evidence: ['Signed written appointment of the principal designer', 'Signed written appointment of the principal contractor', 'Appointment dates'] },
  'dt-client-8':  { requires: 'Where the project is notifiable (longer than 30 working days with more than 20 workers at once, or more than 500 person-days), notify HSE on form F10 and display a copy of the notice.', evidence: ['F10 submission confirmation / reference', 'The notice displayed on site'] },
  'dt-client-9':  { requires: 'Appoint only organisations and individuals with the skills, knowledge, experience and (for organisations) the organisational capability for their role.', evidence: ['Competence and capability checks', 'CVs, qualifications, SSIP or scheme accreditation', 'A record of the assessment made'] },
  'dt-client-10': { requires: 'Ensure suitable welfare facilities (toilets, washing, drinking water, rest and changing) are provided from the start of, and throughout, the construction phase.', evidence: ['Welfare provision plan', 'Photographs or inspection records', 'The welfare section of the construction phase plan'] },

  // ── Designer (CDM 2015) ──
  'dt-designer-1': { requires: 'Do not begin or continue design work until you are satisfied the client is aware of their duties under CDM 2015.', evidence: ['Written confirmation to or from the client', 'Appointment correspondence noting the client duties', 'A file note'] },
  'dt-designer-2': { requires: 'When preparing or modifying a design, eliminate foreseeable health and safety risks so far as is reasonably practicable, applying the general principles of prevention.', evidence: ['Design risk register showing risks eliminated', 'Design review records', 'Option appraisals'] },
  'dt-designer-3': { requires: 'Where a risk cannot be eliminated, reduce or control it through the design.', evidence: ['Design risk register showing residual risks and the control measures designed in'] },
  'dt-designer-4': { requires: 'Provide information about the significant remaining risks with the design, so others can understand and manage them.', evidence: ['Residual risk information issued with drawings', 'Hazard notes on drawings', 'Designer risk register shared with the team'] },
  'dt-designer-5': { requires: 'Cooperate and coordinate your work with the client, the principal designer and other designers.', evidence: ['Design coordination meeting minutes', 'Correspondence with the principal designer', 'Shared risk information'] },

  // ── Principal designer (CDM 2015) — CITB CDM 2015 industry guidance for principal designers ──
  'dt-principal_designer-1': { requires: 'Plan, manage and monitor the pre-construction phase so foreseeable risks are managed, coordinating design work across the team.', evidence: ['Principal designer management plan', 'Coordination meeting minutes', 'Monitoring records for the pre-construction phase'] },
  'dt-principal_designer-2': { requires: 'Identify foreseeable risks and ensure designers eliminate them, or reduce and control what remains, applying the general principles of prevention.', evidence: ['Consolidated design risk register', 'Design review records', 'Evidence that risks were designed out'] },
  'dt-principal_designer-3': { requires: 'Ensure all designers cooperate, coordinate their work and comply with their duties.', evidence: ['Designer coordination records', 'Correspondence confirming designer duties', 'Meeting minutes'] },
  'dt-principal_designer-4': { requires: 'Assist the client in identifying, obtaining and providing the pre-construction information, and pass it to designers and contractors.', evidence: ['Pre-construction information compiled or assisted', 'Transmittal records', 'Input into the pre-construction information pack'] },
  'dt-principal_designer-5': { requires: 'Provide relevant information to designers and contractors so they can carry out their work safely.', evidence: ['Records of information issued', 'Design risk information shared'] },
  'dt-principal_designer-6': { requires: 'Liaise with the principal contractor and share information relevant to the construction phase, including any design carried out during it.', evidence: ['Principal designer / principal contractor liaison minutes', 'Information handover to the principal contractor', 'Correspondence'] },
  'dt-principal_designer-7': { requires: 'Prepare a health and safety file appropriate to the project, containing the information needed for future construction, maintenance and use.', evidence: ['The health and safety file', 'Contents / index', 'Records requested from the team'] },
  'dt-principal_designer-8': { requires: 'Review, update and revise the health and safety file as the project progresses. If you leave before the end, pass it to the principal contractor; otherwise pass it to the client at completion.', evidence: ['Updated health and safety file', 'Handover record to the client or principal contractor', 'Version history'] },

  // ── Principal contractor (CDM 2015) — CITB CDM 2015 industry guidance for principal contractors ──
  'dt-principal_contractor-1':  { requires: 'Draw up the construction phase plan before the site is set up, and revise it as the work proceeds. It must set out the health and safety arrangements and site rules for the project.', evidence: ['The construction phase plan', 'Revisions', 'The arrangements and site-rules sections'] },
  'dt-principal_contractor-2':  { requires: 'Plan, manage and monitor the construction phase so the work is carried out without risks to health and safety.', evidence: ['Site management records', 'Inspection and monitoring reports', 'Toolbox talks'] },
  'dt-principal_contractor-3':  { requires: 'Organise cooperation between contractors and coordinate their work so they do not create risks for each other.', evidence: ['Contractor coordination meeting minutes', 'Sequencing and interface records'] },
  'dt-principal_contractor-4':  { requires: 'Ensure a suitable site induction is given to everyone, and take reasonable steps to prevent unauthorised people reaching the site.', evidence: ['Induction records / register', 'Site access controls, hoarding and signage', 'Security arrangements'] },
  'dt-principal_contractor-5':  { requires: 'Ensure welfare facilities are provided and maintained throughout the construction phase.', evidence: ['Welfare inspection records', 'Provision on site', 'The welfare arrangements in the construction phase plan'] },
  'dt-principal_contractor-6':  { requires: 'Consult and engage with workers, or their representatives, on matters affecting their health, safety and welfare.', evidence: ['Worker consultation records', 'Safety meetings', 'Briefings and feedback mechanisms'] },
  'dt-principal_contractor-7':  { requires: 'Ensure there are safe places of work with safe access and egress, kept in a safe condition.', evidence: ['Access and egress arrangements', 'Inspection records', 'Scaffold and edge-protection records'] },
  'dt-principal_contractor-8':  { requires: 'Keep the site in good order and, so far as is reasonably practicable, secure.', evidence: ['Housekeeping inspections', 'Site security and perimeter records'] },
  'dt-principal_contractor-9':  { requires: 'Take steps to prevent danger from the instability of new or existing structures, using temporary supports where needed.', evidence: ['Temporary works design and register', 'Temporary works coordinator records', 'Propping and support details'] },
  'dt-principal_contractor-10': { requires: 'Plan and carry out demolition or dismantling so as to prevent danger, under arrangements recorded in writing before the work begins.', evidence: ['Demolition method statement / plan', 'Pre-demolition survey', 'Written arrangements agreed before work starts'] },
  'dt-principal_contractor-11': { requires: 'Take steps to prevent danger from excavations, including collapse, and prevent people, materials or vehicles falling in.', evidence: ['Excavation permits and inspections', 'Support or battering details', 'Inspection register'] },
  'dt-principal_contractor-12': { requires: 'Organise traffic routes so pedestrians and vehicles can move safely, separating them where reasonably practicable.', evidence: ['Traffic management plan', 'Site layout', 'Segregation and signage records'] },
  'dt-principal_contractor-13': { requires: 'Provide suitable fire prevention, detection and fire-fighting arrangements for the site.', evidence: ['Fire plan / fire risk assessment', 'Extinguisher and alarm records', 'Hot works permits'] },
  'dt-principal_contractor-14': { requires: 'Provide emergency procedures, routes and exits, and make sure they are known and kept clear.', evidence: ['Emergency plan', 'Muster points', 'Drill records', 'Signage'] },
  'dt-principal_contractor-15': { requires: 'Provide fresh air, a reasonable working temperature, protection from the weather and suitable lighting.', evidence: ['Provision on site', 'Inspection records', 'Lighting and heating arrangements'] },

  // ── Contractor (CDM 2015) ──
  'dt-contractor-1': { requires: 'Do not start construction work until you are satisfied the client is aware of their client duties.', evidence: ['Confirmation that the client is aware', 'Correspondence', 'A file note'] },
  'dt-contractor-2': { requires: 'Plan, manage and monitor your own work and that of your workers so risks are controlled.', evidence: ['Risk assessments and method statements (RAMS)', 'Supervision records', 'Inspections'] },
  'dt-contractor-3': { requires: 'Comply with directions given by the principal designer or principal contractor, and with the parts of the construction phase plan that apply to your work.', evidence: ['Signed acknowledgement of the construction phase plan and site rules', 'Records of complying with principal-contractor directions'] },
  'dt-contractor-4': { requires: 'Where you are the only contractor on the project, ensure a construction phase plan is drawn up.', evidence: ['The construction phase plan drawn up for the single-contractor project'] },
  'dt-contractor-5': { requires: 'Provide your workers with appropriate supervision, information, instruction and training.', evidence: ['Induction and training records', 'Supervision arrangements', 'Toolbox talks', 'Competence records'] },

  // ── Principal designer, Building Regulations (2010 Part 2A) — government Building Regulations dutyholder guidance ──
  'dt-br_principal_designer-1': { requires: 'Plan, manage and monitor the design work during the design phase so that, if built in accordance with the design, the building work would comply with the Building Regulations.', evidence: ['Building Regulations design management plan', 'Compliance coordination records', 'Design review minutes'] },
  'dt-br_principal_designer-2': { requires: 'Coordinate matters relating to the design so all designers comply with the relevant requirements of the Building Regulations.', evidence: ['Design coordination records', 'Compliance tracking across disciplines'] },
  'dt-br_principal_designer-3': { requires: 'Ensure designers cooperate with the principal designer and comply with their Building Regulations duties.', evidence: ['Designer cooperation records', 'Correspondence confirming the Building Regulations duties'] },
  'dt-br_principal_designer-4': { requires: 'Liaise with the principal contractor (Building Regulations) and share information relevant to Building Regulations compliance.', evidence: ['Liaison minutes', 'Compliance information handover'] },
  'dt-br_principal_designer-5': { requires: 'Assist the client in meeting their Building Regulations duties.', evidence: ['Advice and records provided to the client on their Building Regulations duties', 'Input to the client arrangements'] },

  // ── Principal contractor, Building Regulations (2010 Part 2A) ──
  'dt-br_principal_contractor-1': { requires: 'Plan, manage and monitor the building work during the construction phase so the completed work complies with the Building Regulations.', evidence: ['Building Regulations construction / compliance plan', 'Inspection and compliance records'] },
  'dt-br_principal_contractor-2': { requires: 'Coordinate the work of contractors so the building work meets the relevant requirements of the Building Regulations.', evidence: ['Contractor coordination records', 'Compliance checks across trades', 'Golden-thread records'] },
};

// Seed guidance into duty_templates where it is not already set (never overwrite
// a consultant's edits). Idempotent.
async function seedGuidance(pool){
  let n = 0;
  for(const id of Object.keys(GUIDANCE)){
    const r = await pool.query(
      `UPDATE duty_templates SET guidance = $1::jsonb
        WHERE id = $2 AND (guidance IS NULL OR guidance = '{}'::jsonb)`,
      [JSON.stringify(GUIDANCE[id]), id]
    );
    n += r.rowCount;
  }
  console.log('✓ Duty guidance seeded into ' + n + ' templates');
}

module.exports = { GUIDANCE, seedGuidance };
