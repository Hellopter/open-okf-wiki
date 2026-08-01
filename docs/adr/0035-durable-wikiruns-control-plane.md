# Durable WikiRuns control plane

**Status:** accepted  
**Date:** 2026-07-28  
**Supersedes:** [ADR 0032](0032-pi-tool-owned-wiki-runs.md) only for whole-Run Pi-tool ownership and the prohibition on durable Run commands/events  
**Refines:** [ADR 0034](0034-deep-modules-thin-tools-single-projection.md), [ADR 0033](0033-run-graph-and-agent-layering.md)  
**Retains:** Pi-only Operator Session conversation events, `SessionManager` authority for conversations, `@okf-wiki/core` Run Boundary, and no-compat cleanup  
**Narrowly superseded by:** [ADR 0036](0036-semantic-artifact-plane-and-execution-plan.md) for fixed Definition v1 topology as the product semantic ceiling; current contract is `okf.wiki-runs/v5` (control plane ownership, artifacts, gates, effects, and Run SSE remain)

> **2026-08-01 status note:** References to a separate Operator Session HTTP/SSE surface are historical. The browser operates durable Runs directly; Pi is used only for disposable Attempt execution.

## Context

A Wiki Run must survive server restarts, Pi Attempt loss, and SSE disconnection; it must retain typed operator gates and permit audit-safe retry or rerun. A long-running Pi tool Promise and in-memory gate cannot own those transitions.

## Decision

`WikiRuns` is the durable control authority for one Workspace. It owns Runs, Nodes, Attempts, Gates, Artifacts, Effects, and low-frequency Run Events. Pi executes a single discardable Attempt. `wiki_produce` dispatches `StartRun` and returns a receipt; it does not wait for the Run or own its lifecycle.

At acceptance this ADR fixed `okf.wiki-runs/v1`: definition version 1, strict Run commands, secret-free snapshots, durable events, typed gates, attempts, artifacts, and effects. The current hard-cut contract is `okf.wiki-runs/v5`; commands remain idempotent by `(workspaceId, commandId)`. HTTP and Pi adapters derive workspace and actor context from their authenticated route/session and never accept either in a command body.

Definition v1 is Wiki-specific, not a general workflow DSL:

```text
freeze -> plan -> gate.plan -> research.leaf.* -> research.domain.*
       -> write.root -> validate.pre -> review.seat.* -> review.reduce
       -> repair.<round> -> validate.final -> prepare.publication
       -> gate.publication -> publish
```

`RetryFailedNode` requires the current node generation and failed/interrupted Attempt and reuses its exact input digest. `RerunNode` increments the target generation and invalidates only downstream nodes that consumed old output lineage. `CancelRun` withdraws open gates and prevents future claim, resolution, final artifact commit, and new effect application. Late Attempts cannot commit without matching current Attempt id, generation, running state, and `cancel_requested = false`.

Plan, operator-input, and publication Gates carry a sealed payload digest. `ResolveGate` validates the current open gate, digest, cancellation state, command idempotency, and server-derived actor before its one allowed typed transition. A duplicate command returns its first receipt; a different command against a closed or replaced gate is stale.

Artifacts are immutable. Attempt-private work is not recovery input. Frozen Repository Snapshot Set and Skill materializations are also sealed Artifact records, not special untracked directories, so backup/restore can reproduce an Attempt without revisiting live Git or a latest Skill. A successful Attempt validates work, records a prepared Artifact intent, seals and verifies content on the Artifact volume, then conditionally commits the Artifact and node output. Recovery may replay only a prepared, verified Artifact whose Attempt and generation are still current; otherwise it is orphaned.

`prepare.publication` captures the live baseline under the publication lock, then materializes, rewrites, stamps, indexes, validates, and seals the exact publication candidate before opening the publication Gate. That Gate binds candidate digest, baseline digest, owning publication node generation, and Effect identity. Publication is an effect state machine: `prepared -> candidate_ready -> applying -> applied`, with `conflict`, `failed`, `unknown`, and pre-apply `cancelled` outcomes. Apply only verifies and swaps that sealed candidate; it never changes bytes after approval. Both `candidate_ready -> applying` and cancellation/invalidation validate the still-current owning node generation and approved Gate. The live baseline digest is checked under the publication lock before rename. `applying` is reconciled after a crash; it is never reported as cancelled merely because cancellation was requested later.

Run SSE is separate from Operator Session SSE. It starts with a secret-free Snapshot and then replays durable events after `Last-Event-ID`; heartbeat has no event id. Session SSE continues to forward only genuine Pi conversation events.

The initial implementation is one localhost Server owner per Workspace using one `node:sqlite` connection and immutable filesystem Artifacts. It must verify owner acquisition/release and backup/restore in CI on Node `22.23.x`; it does not add repository, storage, or per-table store ports.

### Control store: SQLite is the implementation, not the architecture

What is required is an atomically committable **Run control true source** (command idempotency, node/attempt/gate CAS, lineage, durable events, effect intent). SQLite is the **recommended localhost implementation**, not a universal requirement and not interchangeable with Pi’s session store.

| Store | Role |
|---|---|
| `workflow.sqlite` (`@okf-wiki/workflow`) | WikiRuns control plane only |
| Pi Session JSONL (optional future Pi Session SQLite) | Operator conversation and Attempt transcripts; `/tree` lives here |
| Filesystem sealed Artifacts | Snapshot/Skill/wiki/candidate bytes; DB holds refs and digests |

Do **not** reuse `@earendil-works/pi-storage-sqlite-node` / AgentHarness `SessionRepo` as the WikiRuns database: its schema is session entries/branches/materialized views, not runs/nodes/gates/effects. Coding Agent `createAgentSession` still takes `SessionManager`; the harness SQLite backend is not a drop-in for that path.

**Pi upstream (checked 2026-07-28/29)** strengthens session durability and tool-level pause/resume discussions; it does **not** supply a Wiki DAG control plane. Treat these as evidence for host-owned durability, not as a reason to delete `workflow.sqlite`:

- [PR #6594](https://github.com/earendil-works/pi/pull/6594) (merged): SQLite **session** storage for AgentHarness.
- [PR #7163](https://github.com/earendil-works/pi/pull/7163): FTS search on that session SQLite.
- [#7053](https://github.com/earendil-works/pi/issues/7053) (open): parallel tool results can be lost before session append — execution mid-flight is not durable even with a session store.
- [#5901](https://github.com/earendil-works/pi/issues/5901) (closed): durable HITL **tool-call** interrupt proposal (session/tool model).
- [#5683](https://github.com/earendil-works/pi/issues/5683) / [PR #7111](https://github.com/earendil-works/pi/pull/7111) (closed, **unmerged**): external/deferred tool results on the session transcript — at best an Attempt adapter seam, not node retry, gates, or publish reconcile.
- Pi `packages/agent/docs/durable-harness.md`: semi-durable harness; recover from durable boundaries; unfinished tools default interrupted; no provider exactly-once.

**Alternatives (localhost, no Postgres):** a carefully designed append-only control journal could implement the same semantics but reimplements transaction, recovery, indexing, and cursor consistency — usually harder, not smaller. Temporal/Restate/DBOS and Postgres are valid when multi-host workers or shared control planes appear; they are out of scope while the product remains one Server owner per workspace on local disk. Do not invent per-table repository ports “for a future swap.”

Full issue index and community notes: [docs/research/pi-sqlite-and-wikiruns-control-store-2026-07.md](../research/pi-sqlite-and-wikiruns-control-store-2026-07.md). Working design notes also live under `.scratch/architecture-review-2026-07-28/`.

## Consequences

- Durable mutable Run command and SSE routes are allowed; they must dispatch/read WikiRuns rather than recreate a Session-owned state machine.
- Deleting an Operator Session deletes conversation data only. It does not delete linked WikiRuns control records or audit Artifacts.
- No current process can promise provider exactly-once execution or token-delta persistence.
- Do not introduce `StoragePort`, `GateStore`, `AttemptStore`, `NodeStore`, `EventStore`, an ORM, or a generic workflow engine.
- Do not replace WikiRuns control storage with Pi Session JSONL/SQLite, `/tree` navigation, or unmerged Pi deferred-tool APIs.
- Pin and CI-test the `node:sqlite` Node minor (`22.23.x`); treat ExperimentalWarning as an ops constraint, not a reason to drop the control plane.
