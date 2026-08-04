# Typed plan gate failure and rediscover re-arm

**Status:** accepted  
**Date:** 2026-08-04  
**Refines:** [ADR 0040](0040-use-coverage-units-for-multi-source-and-monorepo-plan-gates.md) (`assertCoverage`), [ADR 0042](0042-semantic-discovery-plane-and-plan-sufficiency.md) (`assertSemanticSufficiency` / `planRescoutMaxRounds`), [ADR 0043](0043-host-owned-multi-wave-discover-orchestration.md) (host-owned discover; no nested agent re-scout)  
**Retains:** WikiRuns control plane (0035), file handoff (0011/0041), dual Spec gates, host budgets  
**Does not introduce:** string-only primary gap detection, same-digest plan retry as gap recovery, unbounded re-discovery, Pi orchestrator  
**Related contract:** `@okf-wiki/contract/pi-attempt` — `failureClass` `coverage_gap` | `semantic_gap`, optional `gateFailure`  
**Related workflow:** `schedulePlanSufficiencyRescout`, `isPlanSufficiencyGapFailure` (host re-arm)

## Context

Dual plan gates (`assertCoverage` / `assertSemanticSufficiency`) already fail-closed on Spec seal. Early wiring mapped both to generic `schema` and free-form error strings, so control-plane re-scout either missed the gap or relied on brittle message regex. Replaying **plan** with the same sealed scout inputs (same-digest retry) cannot close unit/semantic gaps — discovery must re-open.

## Decision

### 1. Typed `gateFailure` on Pi failed outcomes

Failed `PiAttemptOutcome` carries optional structured **`gateFailure`**:

| Field | Role |
|-------|------|
| `kind` | `coverage` \| `semantic_sufficiency` \| `spec_fanout` \| `other` |
| `code` | Stable machine code (e.g. `COVERAGE_GAP`, `SEMANTIC_GAP`) |
| `gaps` | Cap 64 unit / facet ids for host task mapping |
| `result` | Compact gate payload (not a full report dump) |

Plan handler maps `CoverageAssertError` → `coverage_gap` + `gateFailure.kind=coverage`; `SemanticSufficiencyError` → `semantic_gap` + `gateFailure.kind=semantic_sufficiency`. Scheduler preserves `gateFailure` on the thrown control Error for L_control.

### 2. `failureClass` coverage_gap / semantic_gap

Product classes (not transport):

| Class | When |
|-------|------|
| **`coverage_gap`** | Coverage matrix / unit binding gate rejected the Spec |
| **`semantic_gap`** | Semantic sufficiency gate rejected the Spec |

These are distinct from `schema`, `provider`, `transient`, `infrastructure`, etc. Research auto-retry never treats them as transport.

### 3. Host re-arm on plan gap (not same-digest retry)

When a **plan** Attempt fails as a sufficiency gap and scout topology exists:

1. Prefer typed `failureClass` ∈ {`coverage_gap`, `semantic_gap`} and/or `gateFailure.kind` ∈ {`coverage`, `semantic_sufficiency`}.
2. While **`planRescoutMaxRounds`** remains: host **`schedulePlanSufficiencyRescout`** re-arms gap `plan.scout.*` (+ insert missing), re-blocks `plan.discover.reduce` and **plan gen+1**, stamps `sufficiencyRescout` / `discoverWave:2` so L3 two-wave does not treat the wave as intermediate A.
3. Run stays **queued/running** (emit `node.ready`); do **not** `markRunFailed` on successful re-arm.
4. Exhausted budget, light path (no scouts), or non-gap classes → fail closed as today.

**Same-digest plan retry is not gap recovery.** Nested agent re-scout remains forbidden (0043).

### 4. Operator `RetryFailedNode` on plan → re-discover path

Operator recovery of a plan that failed for coverage/semantic gap follows the **re-discover** path (re-arm gap scouts → reduce → plan), not a same-input plan-only replay. Transport/interrupt failures on plan may still use ordinary same-generation retry when inputs are unchanged. `RerunNode` / new Run remain available when lineage or product policy requires a harder reset (0013 / 0035).

### 5. No string-only primary detection

Primary detection is typed: `failureClass` + `gateFailure` (and typed Error names/codes as secondary). Message regex / free-form synthesizer text are **legacy fallback only** — never the sole product path for new agents or host policy.

## Consequences

- Contract: `coverage_gap` / `semantic_gap` + `GateFailureSchema` on failed Pi outcomes.
- Agent plan handler emits structured gaps; skill/docs describe host re-scout ≤ `planRescoutMaxRounds`.
- Workflow re-arm maps `gateFailure.gaps` to source-qualified scout tasks; fail-closed when budget/topology missing.
- Product rejects string-parsing as the primary plan-gap control plane.
