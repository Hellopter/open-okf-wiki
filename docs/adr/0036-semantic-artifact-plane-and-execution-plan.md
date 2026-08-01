# Semantic Artifact Plane and Execution Plan

**Status:** accepted  
**Date:** 2026-07-30  
**Supersedes:** [ADR 0035](0035-durable-wikiruns-control-plane.md) **only** for fixed Definition v1 topology as the *product* execution boundary  
**Retains:** durable WikiRuns control plane (Runs, Nodes, Attempts, Gates, Artifacts, Effects, Run SSE), Pi disposable Attempts, Run Boundary in `@okf-wiki/core`, no-compat culture ([ADR 0029](0029-architecture-cleanup-no-compat.md))  
**Does not introduce:** knowledge graph, multi-writer wiki, generic workflow DSL, dual executors, museum store ports  
**Research basis:** [current-wiki-workflow-optimization-2026-07-29](../research/current-wiki-workflow-optimization-2026-07-29.md), [wiki-workflow-fullstack-pi-architecture-2026-07-30](../research/wiki-workflow-fullstack-pi-architecture-2026-07-30.md), [hard-cut prep](../research/wiki-workflow-hard-cut-prep-2026-07-30.md)

> **2026-08-01 status note:** The current hard-cut contract is `okf.wiki-runs/v5` (`definitionVersion: 5`). The separate Agent Session HTTP/browser surface, `SessionRuntime`, execution-epoch history, pending-guidance revisions, and economy-metric helpers were deleted. The direct browser operator surface is the Run Workspace.

## Context

ADR 0035 correctly established **WikiRuns** as the durable control authority and Pi as a discardable Attempt executor. That control plane stays.

What was insufficient as a *product* boundary was equating “Definition v1 fixed topology” with the full semantic execution contract: DAG edges existed while Spec, receipts, defects, and prior wiki did not reliably flow as typed Attempt inputs; review could fail-open; repair could skip re-review; Pi `agent_end` was treated as session idle; operator focus was dropped at StartRun.

## Decision

### 1. Keep WikiRuns; version the execution contract

- Durable control remains WikiRuns SQLite + immutable filesystem Artifacts + separate Run SSE.
- This ADR introduced `okf.wiki-runs/v2` (`definitionVersion: 2`). The current hard-cut contract is `okf.wiki-runs/v5` (`definitionVersion: 5`); old in-flight runs are not dual-executed.
- **Hard cut:** in-flight prior-version runs are not dual-executed. Operators clear prior-version control stores before opening v5.

### 2. NodeContract (internal registry, not a DSL)

Finite **NodeContract** registry (`packages/workflow/src/wiki-runs/node-contract.ts`) describes required sealed input roles, outputs, and projection. `validateBoundInputs` runs at claim/bind; missing required roles fail closed. Not a user-editable graph language.

### 3. RunIntent → WikiSpec → ExecutionPlan

| Artifact | Answers |
|---|---|
| **RunIntent** | Operator focus, generate/refresh mode, optional objective/constraints |
| **FrozenRunManifest** | Intent digest, mode, skill/sources summary (sealed at freeze) |
| **WikiSpec** (`WikiRunSpec`) | *What* to deliver (domains, pages, acceptance) |
| **ExecutionPlan** | *How* this run executes (`compileExecutionPlan` — fail closed on fan-out caps, no silent `.slice`) |

`StartRun` requires `intent`. Plan gate binds Spec digest + Plan digest. Plan revise loads prior Spec + feedback.

### 4. Evidence projection and AnalysisReceipt

Attempt materialize projects sealed inputs under `inputs/` (spec, execution-plan, evidence index/receipts, defects, operator-input, prior-wiki). Leaf/Domain emit full `AnalysisReceiptSchema`. Writer consumes EvidenceBundle index. Transcripts remain audit-only.

Refresh mode freezes published wiki as `prior_wiki` and seeds the writer from it.

### 5. EvaluationRound

```text
WikiCandidate → mechanical validate → typed DefectReport seats → review.reduce
  → clean | repairable | exhausted
repair → re-arm validate.pre + seats + reduce (no skip re-seats)
```

Review seats submit `DefectReportSchema` (fail closed). Reduce merges only validated reports. Spec `blockingSeverities`, `reviewRequired`, and critical pages are host-enforced.

### 6. Durable operator_input HITL

`gate_requested` → Attempt `suspended`, Gate `operator_input` open, Run `waiting_for_operator`. Answer seals `operator_input` artifact; new generation Attempt binds frozen inputs + answer. Restart does not resume the old Pi worker.

### 7. Operator surface

- The browser owns Run Workspace paths: `/w/:id/runs`, `/w/:id/runs/:runId`, and review at `/w/:id/runs/:runId/review`.
- Resource-keyed command state (`run:…:cancel`, `gate:…:resolve`, `node:…:retry`).
- There is no browser-facing Operator Session, session route, or Session SSE adapter.

### 8. Light path

- Default: `planScoutCount=0`, `reviewCouncilSize=1`; adaptive raise from inventory/uncertainty only.
- Single-leaf domains edge leaf → write.root (no forced domain reducer).
- Shared sealed source mount via hardlink-first (copy fallback).

## Consequences

- Definition v1 fixed topology is no longer the permanent product ceiling; new runs use the versioned execution contract with NodeContract-backed projection.
- Supersession of ADR 0035 is **narrow**: control plane ownership, artifacts, gates, effects, and Run SSE remain.
- Fail-open review heuristics, silent fan-out slice, bare StartRun without intent, `agent_end`=idle, await-prompt-as-202, and message-derived activeRunId are deleted.
- Knowledge graph, multi-writer, and generic workflow engines remain out of scope.
