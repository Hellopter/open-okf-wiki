# Host-owned multi-wave discover orchestration

**Status:** accepted  
**Date:** 2026-08-04  
**Refines:** [ADR 0040](0040-use-coverage-units-for-multi-source-and-monorepo-plan-gates.md) (CoverageUnit / hybrid scouts / assertCoverage), [ADR 0042](0042-semantic-discovery-plane-and-plan-sufficiency.md) (DiscoveryMap / semantic scouts / assertSemanticSufficiency / L0–L3)  
**Retains:** WikiRuns control plane (0035), file receipts with control returns (0011), path-first handoffs (0041), single Spec authority, host mechanical validate, HandoffEnvelope  
**Does not introduce:** Pi orchestrator node, LLM free-spawn of plan topology, knowledge graph, dual Spec authorities, unbounded re-discovery  
**Related contract:** `@okf-wiki/contract` — `selectPlanScoutTasks`, `resolvePlanScoutConcurrency`, source-qualified semantic scout ids, `plan.discover.reduce`  
**Related workflow:** `@okf-wiki/workflow` — `materializePlanScoutsAfterFreeze`, L3 two-wave (`discoverWave` 1|2)

## Context

ADR 0040 made coverage fail-closed; ADR 0042 added DiscoveryMap, semantic scout kinds, and `assertSemanticSufficiency`. Implementation still needed a **host-owned** discover topology that:

1. Does not put an LLM in charge of which scouts exist or when reduce runs.
2. Runs plan scouts in parallel even when thematic `planScoutCount` is 0 (multi-source thematic DEFAULT-OFF).
3. Qualifies domain/flow discovery per source (plus one multi-source `flow:cross`) so multi-repo synthesis cannot collapse into a single global scout.
4. For L3 multi-source, materializes discovery in **two waves** so semantic scouts can assume unit surveys (and intermediate reduce) already sealed.

## Decision

### 1. Host owns discover orchestration (no Pi orchestrator node)

Discover topology is **host-materialized** on the durable WikiRuns DAG after freeze (and on bounded re-scout):

```text
light (L0):     freeze → plan
one-wave:       freeze → plan.scout.* → plan.discover.reduce → plan
L3 two-wave:    freeze → Wave A plan.scout.* → plan.discover.reduce (wave 1)
                     → Wave B plan.scout.* → plan.discover.reduce (wave 2) → plan
```

- Task selection is pure contract (`selectPlanScoutTasks`). Workflow only inserts/re-arms nodes.
- `plan.discover.reduce` is mechanical (host merge; no Pi session).
- Agents execute **assigned** `plan.scout` / `plan` nodes only. They do **not** spawn sibling scouts, invent topology, or call reduce.
- Nested agent re-scout is forbidden; coverage/semantic gaps re-arm via host `planRescoutMaxRounds` only.

### 2. Parallel `plan.scout` concurrency floor 2

`resolvePlanScoutConcurrency` is independent of thematic soft-spine count:

| Input | Resolved concurrency |
|-------|----------------------|
| Explicit `planScoutConcurrency` | That value (capped by `maxPlanScoutConcurrency`) |
| Omitted, any `planScoutCount` | **`max(planScoutCount, 2)`**, capped |

**Never** use `planScoutCount || 1` as the sole default — that serializes multi-source unit surveys when thematic count stays 0. Global `maxConcurrentAttempts` must not undercut resolved scout width on multi-source / large single-repo paths.

### 3. Source-qualified domain / flow + `flow:cross`

Semantic scout identity is source-scoped (except the single cross-flow):

| Id shape | Role |
|----------|------|
| `domain:{sourceId}` | Per-source domain candidates |
| `flow:{sourceId}` | Per-source flow candidates |
| `flow:cross` | Multi-source join / composition (required when `sourceCount ≥ 2`) |

Bare global `domain` / `flow` without `sourceId` are not scheduled on the multi-source path. Concept remains optional (not auto-required). Thematic `entry|layout|tests|risks` stay soft; multi-source thematic DEFAULT-OFF (ADR 0042).

### 4. L3 two-wave materialize (A unit, B semantic)

When `sourceCount ≥ 2` and both unit and semantic tasks are selected:

| Wave | Tasks | Reduce |
|------|--------|--------|
| **A (unit)** | `source` / `surface` surveys only | Intermediate `plan.discover.reduce` with `discoverWave: 1` |
| **B (semantic)** | Source-qualified `domain` / `flow`, `flow:cross`, optional thematic/concept | Final reduce with `discoverWave: 2` |

- Freeze materializes Wave A only; Wave B inserts after intermediate reduce success.
- Plan stays blocked until the **final** reduce succeeds.
- Critical scouts must succeed; optional may fail/cancel without blocking reduce readiness rules already defined in workflow.
- Single-source L1/L2 keeps **one wave** (no forced double reduce).

### 5. File handoff retained

Unchanged from ADR 0042 §2:

- Sealed DiscoveryMap / scout receipts / Spec under the Run Boundary are authority.
- Control returns use short **HandoffEnvelope**; chat paste is never discovery or Spec authority.
- Dual plan gates remain: **`assertCoverage`** (0040) and **`assertSemanticSufficiency`** (0042) on Spec seal paths.

## Consequences

- Discover cost and width are host budgets (`planSurveyTaskBudget`, `planScoutConcurrency`, `planRescoutMaxRounds`), not model inventiveness.
- Multi-source runs get parallel unit surveys, then parallel semantic scouts, then one synthesizer Spec — primacy bias is structural, not prompt-only.
- Skill / plan method documents host multi-wave discover, parallel scouts, source-qualified discovery, and dual gates; agents read sealed files only.
- Product still rejects Pi-as-orchestrator for plan topology, LLM free-spawn of DAG nodes, KG, and unbounded re-discovery.

## Related

- Producer Skill plan method: `packages/skill/references/plan.md`
- Scout selection: `packages/contract/src/plan-scouts.ts`
- Concurrency floor: `packages/contract/src/workspace.ts` (`resolvePlanScoutConcurrency`)
- Wave materialize: `packages/workflow/src/wiki-runs/plan-scout-materialize.ts`
