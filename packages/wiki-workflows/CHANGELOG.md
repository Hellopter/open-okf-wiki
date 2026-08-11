# Changelog

All notable changes to `@okf-wiki/wiki-workflows` are documented in this file.

## [Unreleased]

### Architecture

- **Session pointer-only.** Pi custom entries (`WikiRunSession`) are pointer-only (`pointerVersion: 1`, `runId`, `revision`, `status`, `updatedAt`, `workspace`). Full `WikiRunSnapshot` bodies live in the project history store. Legacy full-snapshot session entries are rejected fail-closed (no dual-read). Restore path: parse pointer → `historyStore.load(runId)` → `engine.restore(snapshot)`. Host session appends only on critical events (not `node_activity` / `node_started`).
- **Snapshot v8 — no migrate.** Durable run snapshots use `version: 8`. Older history is **rejected** fail-closed. Blob handoffs under `.okf-wiki/blobs/`; receipts include `criticalGapQuestions` for expand-scope binding. After upgrade, clear stale `.okf-wiki/` and history then `/wiki generate`.
- **Recovery / retry.** Interrupted (`running`/`paused`) history can be forked for retry; UI `waitAgentSettle` only when the active engine still has a live node controller.
- **Research stop.** Expand hard-rejected without critical gaps; expand scopes must reference gap questions; dry audit skipped when no critical gaps; dry fingerprints normalize evidence paths.
- **JoinBarrier success path.** Research and write fan-in no longer races on concurrent batch completion. After a node is marked `status=succeeded`, the engine calls `tryJoinAfterSuccess` once; pure `evaluateJoin` / `siblingsByGroupKey` (`join-barrier.ts`) decide `not_ready` vs `all_succeeded` before queueing synthesis or verification. The historical `reconcileCompletedBatch` re-entry path is gone.
- **Research budget split; `requiredDryCoverageAudits` default 1.** Policy splits expand vs audit accounting (`maxExpandRounds`, `maxAuditRounds`, `requiredDryCoverageAudits`). Happy path requires a single consecutive dry coverage audit before writers are queued (default `requiredDryCoverageAudits: 1`). Budget exhaustion surfaces as typed codes (`research_rounds_exhausted`, `expand_rounds_exhausted`, `audit_rounds_exhausted`), not message regex.
- **`blockedDetails` diagnostics.** Terminal blocked runs may carry structured `blockedDetails` (`code`, `issues`, `defects`, `page`, remaining budget, …) for UI and ops without a snapshot version bump.
- **Restore artifact health check.** After accepting a valid snapshot, `checkRunArtifactHealth` verifies succeeded research/synthesis/review handoffs are still readable from the artifact store so resume cannot dispatch into a graph with missing blobs (`missing_handoff_artifacts`).
- **Module split (engine thinner).** Graph transitions, join fan-in, phase labels, node parsers, and checkpoint coordination live in focused modules (`transitions-queue`, `join-barrier`, `workflow-phases`, `run-nodes`, `run-graph`, `checkpoint`, `run-health`, …). `engine.ts` remains the facade + pump; behavior is delegated rather than monolithic.
