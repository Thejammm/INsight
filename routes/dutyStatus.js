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
  awaiting_review:      'Awaiting review',
  reviewed:             'Reviewed',
  returned:             'Returned',
};

// Sign-off wording — reviewer-neutral, so it reads correctly whoever signs (AHS
// or a nominated client reviewer). The signer's name and organisation are
// stamped alongside it (reviewed_by / reviewed_by_org). The non-transfer line is
// shown on every sign-off regardless of who reviewed.
const REVIEW_WORDING = {
  reviewed:    'Reviewed: the evidence provided appears to satisfy the requirement',
  nonTransfer: "This review does not transfer or discharge the dutyholder's legal duty, which remains with the appointed organisation.",
};

// ── Per-role reviewer resolution ────────────────────────────────
// The reviewer of a role's duties is stored per project in projects.reviewers
// as { role: ref }, where ref is an appointed org id or the sentinel 'ahs'
// (the consultant). An absent/blank ref falls back to 'ahs'.
function asReviewers(v){
  if(v && typeof v === 'object' && !Array.isArray(v)) return v;
  if(typeof v === 'string'){ try { const j = JSON.parse(v); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; } catch(e){ return {}; } }
  return {};
}
function reviewerRefForRole(reviewers, role){
  const ref = asReviewers(reviewers)[role];
  return (ref && String(ref).trim()) ? String(ref) : 'ahs';
}
// May this user sign off / return this duty? `duty` needs { role, org_id }.
//   - reviewer = 'ahs'  → the consultant only.
//   - reviewer = an org → that org's users only, and never the org that holds
//     the duty (no signing off your own homework).
function canReviewDuty(user, duty, reviewers){
  const ref = reviewerRefForRole(reviewers, duty.role);
  if(ref === 'ahs') return user.role === 'consultant';
  if(ref === duty.org_id) return false;              // reviewer would be the holder — never
  return user.role === 'client_user' && !!user.tenantId && user.tenantId === ref;
}

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
    const label = st === 'returned' ? 'Returned' : st === 'awaiting_review' ? 'Awaiting review'
                : st === 'evidence_outstanding' ? 'Evidence outstanding' : 'Not started';
    items.push({ id: r.id, duty: r.duty, role: r.role, citation: r.citation, orgName: r.org_name || null, status: st, label, pr });
  });
  items.sort((a, b) => a.pr - b.pr);
  return items;
}

module.exports = { deriveStatus, asEvidence, computeDutyStats, outstandingList, STATUS_LABELS, REVIEW_WORDING, asReviewers, reviewerRefForRole, canReviewDuty };
