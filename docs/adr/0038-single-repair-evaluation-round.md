# Single repair kind and EvaluationRound runtime

**Status:** accepted  
**Date:** 2026-07-30  
**Supersedes:** dual product paths `repair.hv.*` / `repair.review.*` (0037 transitional dual schedule)  
**Refines:** [0036](0036-semantic-artifact-plane-and-execution-plan.md), [0037](0037-wiki-candidate-evaluation-round.md)  
**Compat:** **none** — hard cut; cancel non-terminal runs on upgrade  

## Decision

1. **One repair node family:** `repair.1` … `repair.N` (`kind=repair`). No `hv` / `review` prefixes in product or control keys.
2. **One scheduler entry:** `scheduleRepair({ repairRequest, feedback? })`. Auto mechanical failure and gate.fix fix both call it.
3. **RepairRequest is the only repair semantic** (`sources`, `baselineCandidateId`, `scope`, `issues`).
4. **After every repair success:** re-arm full EvaluationRound (`validate.pre` + seats + `review.reduce`); never bypass re-eval via topology.
5. **Budgets** only via `EvaluationPolicy` (mechanical/semantic modelRepairBudget + maxCandidates). Count `repair.*` nodes and/or request sources — never `LIKE 'repair.hv.%'`.
6. **Wiki seed** only via `baselineCandidateId` → candidate registry / sealed wiki_tree — no force-`write.root` by node name.
7. **No “HV subagent”** — mechanical channel is host validate+autofix; model repair is the same repairer role.

## Consequences

- Delete `scheduleHardValidateRepair` / `scheduleReviewRepair` / prefix constants as product API.
- Rewrite tests and operator-facing strings.
- Definition edges: `repair.N → validate.pre` always for re-entry.
