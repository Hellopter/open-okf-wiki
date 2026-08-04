# Semantic discovery plane and plan sufficiency

**Status:** accepted  
**Date:** 2026-08-04  
**Refines:** [ADR 0036](0036-semantic-artifact-plane-and-execution-plan.md) (WikiSpec / ExecutionPlan / light path), [ADR 0040](0040-use-coverage-units-for-multi-source-and-monorepo-plan-gates.md) (CoverageUnit gates / hybrid scouts / multi-source never light)  
**Retains:** WikiRuns control plane (0035), file receipts with control returns (0011), path-first handoffs (0041), single Spec authority, host mechanical validate  
**Does not introduce:** knowledge graph, multi-writer wiki, generic workflow DSL, dual Spec authorities, message-primary large payloads  
**Related contract:** `@okf-wiki/contract` — `DiscoveryMap`, `assertSemanticSufficiency`, `HandoffEnvelope`, semantic plan-scout kinds, `inventoryTier` L0–L3, node `plan.discover.reduce`

## Context

ADR 0040 made multi-source and monorepo **coverage** fail-closed (`CoverageUnit`, `assertCoverage`, hybrid source surveys). That still left a **semantic** gap: unit surveys and thematic scouts (entry/layout/tests/risks) do not produce a host-checkable map of domains, cross-source flows, or concept candidates before Spec synthesis. Large chat handoffs also fight the file-authority doctrine (ADR 0011 / 0041).

This ADR adds a sealed **DiscoveryMap** plane, a mechanical reduce node, inventory **L0–L3** routing, and a short **HandoffEnvelope** — without a knowledge graph.

## Decision

### 1. DiscoveryMap (sealed file, not a KG)

`DiscoveryMap` is a versioned JSON artifact (contract schema) with:

| Field | Role |
|-------|------|
| `sources[]` | Per-source role, entryPoints, surfaces, purpose, **evidencePaths** |
| `domains[]` | Candidate domains: title, scope, coverageUnitIds, readerQuestion, evidence |
| `flows[]` | Candidate flows; `crossSource` marks multi-repo joins |
| `concepts[]` | Glossary hints (soft) |
| `modules?` | Optional package/module candidates |
| `openQuestions`, `boundaryPaths`, `scoutKinds` | Residual questions, path list, contributing scout kinds |

Boundary paths remain a **path list only** (ADR 0040 §7). No graph database, claim ledger, or multi-writer store.

### 2. File handoff doctrine

- **File is authority.** Full DiscoveryMap / Spec / receipts live under the Run Boundary.
- Control returns use **`HandoffEnvelope`**: short summary (≤ ~800 chars), status, openQuestions, optional coverage/discovery ids, evidence refs. Optional `payload` must stay tiny.
- **`AnalysisReceipt` remains compatible** for research/review bodies; envelope projects status/summary only.

### 3. Semantic plan scouts + `plan.discover.reduce`

Plan scout kinds:

| Kind | Role | Multi-source default |
|------|------|----------------------|
| `source` / `surface` | Unit surveys (0040) | Required when budgeted |
| `domain` / `flow` | Semantic discovery | **Required** after unit surveys (hybrid / multi-source) |
| `concept` | Glossary soft scout | Not auto-required |
| thematic `entry\|layout\|tests\|risks` | Soft spine | **DEFAULT-OFF** for multi-source (`planScoutCount` may still add soft thematic) |

Mechanical node **`plan.discover.reduce`**:

- Inputs: sealed `scout_receipt`(s)
- Output: `discovery_map` (receipt role)
- Execution: mechanical (host merge; no Pi session)
- Observation stage: `plan`

Plan synthesizer may mount discovery_map as optional input (light path has none).

### 4. `assertSemanticSufficiency` (fail-closed, Spec-bound write)

Host gate (contract pure helper), analogous to `assertCoverage`:

| Situation | Gate |
|-----------|------|
| L0 light / small single-source | Soft pass — DiscoveryMap not required |
| Multi-source (`sourceCount ≥ 2`) | Every required source has discovery `evidencePaths` (≥1) **or** Spec cancel **or** Spec `repositoryMap` entryPoints; **and** a `crossSource` flow **or** explicit openQuestion |

Write path stays **Spec-bound**: discovery candidates inform the planner; only WikiSpec + ExecutionPlan are the sealed plan gate authorities. Discovery does not replace `assertCoverage`.

### 5. Inventory tiers L0–L3

| Tier | Signal | Scout / light path |
|------|--------|--------------------|
| **L0** | Small single-source (e.g. fileCount &lt; 50, no multi-entry/lang) | Light: `planScoutCount=0`, single review lens |
| **L1** | Medium single-source: fileCount ∈ [50, 2000) or mild multi-lang | At least one thematic scout if count was 0 |
| **L2** | Large single-repo / multi-entry / fileCount ≥ 2000 | Raise thematic; surface coverage when inventoried |
| **L3** | Multi-source | **Never light**; hybrid + source coverage + survey budget; thematic default-off |

`inventoryTier(inventory)` is the pure contract helper. Operator-explicit orchestration still wins and is never lowered.

### 6. Orchestration knobs

`planRescoutMaxRounds` remains the host budget for coverage/semantic re-scout rounds (default 1). No unbounded re-discovery.

## Consequences

- Contract package owns DiscoveryMap, semantic sufficiency, handoff envelope, L0–L3, and `plan.discover.reduce` NodeContract.
- Workflow/agent follow-ups: materialize `plan.discover.reduce` after scouts, seal discovery-map.json, call `assertSemanticSufficiency` on multi-source plan seal, prefer HandoffEnvelope on control returns.
- Thematic multi-source auto-raise is removed (default-off); semantic domain+flow carry multi-source discovery cost.
- Knowledge graph, dual Spec, and chat-primary large payloads remain forbidden.
