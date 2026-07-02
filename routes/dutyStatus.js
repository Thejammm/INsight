// ══════════════════════════════════════════════════════════════
//  Duty review-loop status + the confirmed AHS review wording.
//  Shared by routes/projects.js and routes/projectDuties.js (no deps, so no
//  circular imports).
// ══════════════════════════════════════════════════════════════

// Derived status of a project duty (never stored — always computed from the
// discharge / evidence / review fields, so it can't drift):
//   outstanding          — nothing recorded yet
//   evidence_outstanding — a discharge method is recorded but no evidence
//   awaiting_review      — evidence attached, waiting for AHS
//   reviewed             — AHS reviewed and accepted
//   returned             — AHS returned it with a note
// Coerce a jsonb evidence value to an array. node-pg parses jsonb to JS
// automatically; this guards the odd case (or emulator) where it arrives as a
// string or null.
function asEvidence(v){
  if(Array.isArray(v)) return v;
  if(typeof v === 'string'){ try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch(e){ return []; } }
  return [];
}

function deriveStatus(pd){
  if(pd.review_status === 'reviewed') return 'reviewed';
  if(pd.review_status === 'returned') return 'returned';
  if(asEvidence(pd.evidence).length) return 'awaiting_review';
  if(pd.discharge && String(pd.discharge).trim()) return 'evidence_outstanding';
  return 'outstanding';
}

const STATUS_LABELS = {
  outstanding:          'Outstanding',
  evidence_outstanding: 'Evidence outstanding',
  awaiting_review:      'Awaiting AHS review',
  reviewed:             'Reviewed by AHS',
  returned:             'Returned by AHS',
};

// Simon's confirmed wording — used verbatim in the UI and in PDFs.
const REVIEW_WORDING = {
  reviewed:    'Reviewed by AHS: evidence provided appears to satisfy the requirement',
  nonTransfer: "This review does not transfer or discharge the dutyholder's legal duty, which remains with the appointed organisation.",
};

// Aggregate a set of duty rows into dashboard figures.
function computeDutyStats(rows){
  const s = { total: rows.length, reviewed: 0, awaiting: 0, returned: 0, evidenceOutstanding: 0, outstanding: 0 };
  rows.forEach(r => {
    const st = deriveStatus(r);
    if(st === 'reviewed') s.reviewed++;
    else if(st === 'awaiting_review') s.awaiting++;
    else if(st === 'returned') s.returned++;
    else if(st === 'evidence_outstanding') s.evidenceOutstanding++;
    else s.outstanding++;
  });
  s.notStarted     = s.outstanding + s.evidenceOutstanding;   // nothing submitted for review yet
  s.compliancePct  = s.total ? Math.round(s.reviewed / s.total * 100) : 0;
  s.rag            = s.compliancePct >= 80 ? 'green' : s.compliancePct >= 50 ? 'amber' : 'red';
  s.ragLabel       = s.rag === 'green' ? 'On track' : s.rag === 'amber' ? 'In progress' : 'Behind';
  return s;
}

// Outstanding duties, most urgent first: returned, then awaiting review, then
// not started. Reviewed duties are omitted.
function outstandingList(rows){
  const items = [];
  rows.forEach(r => {
    const st = deriveStatus(r);
    if(st === 'reviewed') return;
    const pr    = st === 'returned' ? 0 : st === 'awaiting_review' ? 1 : 2;
    const label = st === 'returned' ? 'Returned' : st === 'awaiting_review' ? 'Awaiting AHS review'
                : st === 'evidence_outstanding' ? 'Evidence outstanding' : 'Not started';
    items.push({ id: r.id, duty: r.duty, role: r.role, citation: r.citation, orgName: r.org_name || null, status: st, label, pr });
  });
  items.sort((a, b) => a.pr - b.pr);
  return items;
}

module.exports = { deriveStatus, asEvidence, computeDutyStats, outstandingList, STATUS_LABELS, REVIEW_WORDING };
