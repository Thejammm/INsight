# AHS InSight

Client compliance platform for construction projects — CDM 2015 and Building
Regulations duty-holder oversight, evidence and consultant sign-off.

Two sides: **clients** log in and see where each project stands (duty holders,
what the law requires, what is outstanding, what is evidenced); **consultants**
(AHS) own the compliance framework, review what the system produces and sign it
off. The framework is data, not code.

## Status

Phase 0 scaffold — Express serves the agreed prototype from `public/` plus a
`/healthz` check so the repo → Coolify → `insight` subdomain pipeline is proven
and the design is live. No database, accounts or real data yet; those arrive in
the phased build.

## Build plan

See `REG_build_plan.md` (in the project working folder). Phases, each with a hard
stop for approval:

0. Setup — repo, reference files, deploy pipeline.
1. Framework as data — Postgres schema for duties/deliverables/triggers/provenance + seed import.
2. Rules engine — project scope answers → applicable duty holders and duties, driven by the data.
3. Portal UI — wire the prototype to real data.
4. Accounts and client isolation.
5. AI agent and consultant review workflow.
6. Deploy.

## Stack

Node, Express, PostgreSQL, JWT. Deploys on Coolify (Hetzner) from GitHub
(`Thejammm/INsight`), push `main` → auto-deploy.

## Run locally

```
npm install
npm start        # http://localhost:3000
```
