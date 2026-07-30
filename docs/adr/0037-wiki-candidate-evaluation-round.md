# WikiCandidate and EvaluationPolicy (mechanical slice)

**Status:** accepted  
**Date:** 2026-07-30  
**Refines:** [ADR 0036](0036-semantic-artifact-plane-and-execution-plan.md) EvaluationRound intent  
**Retains:** WikiRuns control plane (ADR 0035), single Writer, host mechanical validate  

## Context

ADR 0036 required candidate-based evaluation, but the runtime still encoded quality loops as `repair.hv.*` / `repair.review.*` topology specials, forced `write.root` baselines, dual validate citation contracts, and free-text repair feedback. Live runs failed mechanical citation OOB after “successful” repair and multi-round HV discarded prior progress.

## Decision

### 1. WikiCandidate identity

Every sealed `wiki_tree` commit registers a row in `wiki_candidates` (`producedBy`: write | repair | mechanical_fix) with digest, artifact id, parent, and round. Snapshot exposes `candidates[]`. Caps (`maxCandidates`) are enforced when **scheduling** repair, not when recording truth.

### 2. EvaluationPolicy from acceptance

`evaluationPolicyFromAcceptance` maps:

- `maxRepairRounds` → `semantic.modelRepairBudget`
- `maxHardValidateRepairRounds` → `mechanical.modelRepairBudget` (**default 0** — host autofix preferred)
- plus `requireCitations`, autoFix (canonicalize, clamp slack default 1, indexes), `maxCandidates` (default 4)

Scheduler repair budgets and mechanical validate both load this policy (no dual readers).

### 3. Host mechanical autofix

Before score, mechanical validate runs citation clamp/canonicalize (and index regen) when sources are bound. Off-by-one line OOB is fixed without model repair. `validate.pre` and `validate.final` share one citation contract.

### 4. Progressive HV baseline

`repair.hv.1` seeds from `write.root`; `repair.hv.N` (N≥2) seeds from the latest succeeded prior `repair.hv.*` wiki — not a forced dirty write.root.

### 5. RepairRequest

Scheduling HV/review repair embeds a structured `RepairRequest` in node `detail_json` (pages from validation paths, baseline candidate id, scope mode). `PiAttemptNodeDetail` and the writer/repair prompt consume it ahead of free-text feedback. Empty repair (content digest unchanged) fails closed.

### 6. MechanicalReport

Validate reports include a typed `mechanical` block (`MechanicalIssue` codes/hints) alongside legacy string errors.

## Consequences

- Product default no longer auto-spawns model HV rounds for citation nits; raise `maxHardValidateRepairRounds` only when model mechanical repair is required.
- Full EvaluationRound composite node (α) remains future work; β topology (validate / seats / reduce / repair) remains with candidate + policy semantics.
- Knowledge graph, multi-writer, and generic workflow engines remain out of scope.

## Related experience

Anthropic evaluator–optimizer / workflow-first; Garg orchestrator tax (typed handoffs); Cognition caution on default multi-agent swarms.
