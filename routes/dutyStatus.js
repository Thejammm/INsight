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

module.exports = { deriveStatus, asEvidence, STATUS_LABELS, REVIEW_WORDING };
