# Wiki Workflow hard-cut prep (Phase 0)

**Date:** 2026-07-30  
**Status:** operator prep note (not an ADR)  
**Related:** [wiki-workflow-fullstack-pi-architecture-2026-07-30](./wiki-workflow-fullstack-pi-architecture-2026-07-30.md), [ADR 0035](../adr/0035-durable-wikiruns-control-plane.md), draft [ADR 0036](../adr/0036-semantic-artifact-plane-and-execution-plan.md)

## Stance

This refactor is a **hard cut**, not a dual-track migration:

- No dual readers, dual executors, or historical compatibility shims for definition/contract changes.
- No knowledge graph, multi-writer wiki path, or generic workflow DSL.
- SQLite may gain **additive columns** (e.g. attempt metrics) via `migrate()` `ALTER TABLE`.
- **Semantic contract** changes (definitionVersion, node meaning, executor topology) are **not** dual-run: old in-flight semantics are not reinterpreted under a new executor.

## definitionVersion bump

When Phase 1+ ships a new execution contract:

1. `WikiRunDefinitionVersion` / snapshot `definitionVersion` will bump (v1 → v2+).
2. **In-flight v1 runs are NOT migrated** into the new semantics.
3. New `StartRun` uses the new version only.
4. Operators must bring non-terminal v1 runs to a terminal state **before** upgrading the binary that drops v1 execution.

## Operator checklist before schema-breaking upgrades

1. List non-terminal runs for each workspace:

   ```ts
   import { listNonTerminalRuns, openWikiRuns } from "@okf-wiki/workflow";
   // After openWikiRuns (or against the owner DB):
   // listNonTerminalRuns(db) → { runId, state, updatedAt, revision }[]
   ```

   Non-terminal states: `queued` | `running` | `waiting_for_operator` | `cancelling`.

2. For each row, dispatch `CancelRun` (or wait for natural terminal: published / failed / cancelled / completed_unpublished / publication_declined).

3. Confirm `listNonTerminalRuns` is empty.

4. Upgrade Server / workflow package.

5. Do **not** open a dual executor “for safety.” If recovery is required, restore from backup and finish under the **old** binary, then upgrade.

## What migrate() does and does not do

| Change | migrate() behavior |
|---|---|
| Additive attempt metrics columns (`role`, `model_id`, token fields, `wall_time_ms`, …) | `ALTER TABLE` when missing; safe on existing DBs |
| Fresh install `CREATE TABLE attempts` | Includes metric columns |
| definitionVersion / node contract / executor topology | **Not** rewritten in place; hard cut |
| Dual read of v1 + v2 attempt meaning | **Forbidden** |

## Phase 0 observation baseline

Attempt rows now may carry optional metrics (never required for completion):

- `role`, `model_id`
- `input_tokens`, `output_tokens`, `cache_tokens`, `cost_estimate`
- `tool_calls`, `wall_time_ms`, `projection_bytes`
- `stop_reason`, `metrics_json` (catch-all)

Control plane fills `role` / `wall_time_ms` / `stop_reason` on success and fail when known. Pi executor may supply tokens and model id when available. Missing optional metrics never block attempt CAS.

## Helper

`listNonTerminalRuns(db)` in `@okf-wiki/workflow` is a **read-only** upgrade checklist helper. It is not a dual executor and does not migrate runs.
