# wiki-workflows architecture

Git-native repository Wiki DAG workflow for Pi. The engine owns run state; pure modules own policy, phase labels, graph helpers, and join fan-in. UI and extension layers are adapters.

## Module map

| Module | Role |
|--------|------|
| `src/policy.ts` | Tunable budgets/limits (`WikiWorkflowPolicy`, `DEFAULT_WIKI_WORKFLOW_POLICY`, `mergeWikiWorkflowPolicy`, `validMaxResearchRounds`). Research expand vs audit split lives here. |
| `src/failures.ts` | Failure codes, `WikiFailure` / `WikiFailureClass`, `WikiBudgetExhaustedError`, `errorMessage`. Single source for `WikiNodeErrorCode`. |
| `src/util.ts` | Pure helpers: `isRecord`, `clone`, `pathIsInside`, `uniqueStrings`, `stableStringify`; re-exports `errorMessage`. |
| `src/workflow-phases.ts` | Single source of truth for user-visible phases (`WIKI_WORKFLOW_PHASES`, `phaseIdForKind`, `phaseTitleForKind`, `phaseMetaForKind`). Maps node kinds → dashboard stages (synthesis → plan, validate\|review\|finalize → verify). Compat aliases: `WIKI_WORKFLOW_STAGES`, `phaseRefForKind`. |
| `src/workflow-types.ts` | Durable snapshot / node / event types (`WikiRunSnapshot` **version 7**, optional `blockedDetails`). |
| `src/node-retry.ts` | Pure classification of execution errors → node status / terminal run. |
| `src/join-barrier.ts` | Sibling join helpers: `evaluateJoin`, `groupAllSucceeded`, `siblingsByGroupKey`. Success path only (see below). |
| `src/checkpoint.ts` | Debounced, serialized session + history checkpoint coordinator (`WikiCheckpointCoordinator`). |
| `src/engine.ts` | Wiki DAG **facade + pump**: owns run state, scheduling, retries, terminalization; delegates transitions to `transitions-queue` via `TransitionHost`. |
| `src/transitions-queue.ts` | Per-kind success transitions, graph expansion (`queue*`, `ensure*`, join fan-in via `tryJoinAfterSuccess`), terminal block policy with `blockedDetails`. Host-injected; no executor/Pi. |
| `src/run-nodes.ts` | Node input/result parsers (`ResearchNodeInput`, `SynthesisNodeInput`, `PagePacketInput`, `WikiNodeInputByKind`, `parseNodeInput`), fingerprints, repair/write packet helpers, validation issue routing. |
| `src/run-graph.ts` | Phase membership, fork/invalidate closure, terminal checks; `phaseTitleFor` delegates to `workflow-phases`. |
| `src/prompts.ts` | Agent prompt builders for research / synthesis / write / review. |
| `src/path-policy.ts` | Safe path resolution for wiki and source trees. |
| `src/submissions/contracts.ts` | Model-facing JSON field-name contracts for control submission tools (shared by agents + prompts). |
| `src/wiki-validate.ts` | Content/spec validation issues used by the verify phase. |
| `src/wiki-indexes.ts` | Index page materialization helpers. |
| `src/wiki-finalize.ts` | Finalization (indexes, obsolete pages) after verify passes. |
| `src/validate.ts` | Facade re-exporting inspect/validate/finalize entry points used by the engine. |
| `src/artifact-store.ts` | Durable handoff blobs; size limits mirrored in `policy.artifacts`. |
| `src/snapshot-validation.ts` | Fail-closed snapshot schema checks (version 7, optional `blockedDetails`). |
| `src/executor.ts` | Pi agent executor (runs a single node against the coding agent). |
| `src/extension.ts` | Pi extension wiring: commands, run lifecycle, UI host, session restore. |
| `src/ui/*` | Dashboard / navigator / stages / format / task panel — pure-ish presentation over snapshots. Stages re-export `WIKI_WORKFLOW_PHASES` as `WIKI_WORKFLOW_STAGES`. |

## Import rules

- **Leaf pure modules** must not import `@earendil-works/*`:
  - `policy.ts`, `failures.ts`, `util.ts`
  - `workflow-phases.ts`
  - `join-barrier.ts`
  - `transitions-queue.ts` (host-injected; no executor/Pi)
  - `run-graph.ts`, `run-nodes.ts` (pure graph helpers)
  - `path-policy.ts`, `checkpoint.ts` (no Pi)
  - `submissions/contracts.ts` (field names only)
  - `research-receipt.ts`, `run-health.ts`
- Enforced by `pnpm check:boundaries` (`scripts/check-import-boundaries.mjs`); also run from `pnpm test`.
- Node built-ins (`node:path`, `node:crypto`, …) are fine.
- `workflow-types.ts` may type-alias / re-export codes from `failures.ts`.
- Engine, executor, extension, and UI host may depend on Pi packages.
- Prefer `workflow-phases` for any user-visible stage id/title; do not hard-code `{ id: "plan", title: "Plan" }` at queue sites — use `phaseMetaForKind(kind)`.

## Node input typing (incremental)

- Durable `WikiNode.input` remains `unknown` on the snapshot type; a full discriminant `WikiNode` union is **incremental** and not required for correctness today.
- **Runtime contract**: `parseNodeInput(kind, value)` in `run-nodes.ts` validates and normalizes known shapes at queue boundaries (`newNode` / `queueNode` in `transitions-queue.ts`).
- Strong shapes today: `ResearchNodeInput`, `SynthesisNodeInput`, `PagePacketInput` (mapped by `WikiNodeInputByKind`).
- Other kinds (`inspect`, `validate`, `review`, `finalize`) accept a plain object record until dedicated interfaces land.
- Readers should prefer `researchInputFor` / `synthesisInputFor` / `pagePacketInputFor` (or `parseNodeInput`) over ad-hoc casts.

## Atomic wiki page writes

- `files.writeText` writes to a same-directory temp file then `rename`s (same pattern as `artifact-store` / path-policy handoffs).
- Index materialization (`wiki-indexes`) uses `writeText` so index projection is atomic on the same filesystem.

## Snapshots

- **No old-snapshot migration path.**
- Snapshot `version` is **7**. Incompatible older versions are **rejected** (fail closed) by `snapshot-validation.ts`.
- New failure codes are additive on nodes; unknown codes remain representable as strings where needed.
- Optional `blockedDetails` on terminal blocked runs carries structured diagnostics (`code`, `issues`, `defects`, `page`, …) without a version bump.

## Research budgets

Policy splits expand vs audit accounting (`policy.research`):

| Field | Default | Meaning |
|-------|---------|---------|
| `maxExpandRounds` | 4 | Coverage-growth rounds (tighter happy path) |
| `maxAuditRounds` | 3 | Dry-coverage audit rounds |
| `requiredDryCoverageAudits` | 1 | Consecutive dry audits required before write (happy-path tighten) |
| `maxResearchRounds` | 6 | Legacy combined ceiling still used by the current engine pump until split accounting is fully wired |

Classification of round exhaustion uses **codes** via `WikiBudgetExhaustedError` — never message regex:

- `research_rounds_exhausted`
- `expand_rounds_exhausted`
- `audit_rounds_exhausted`

Terminal block codes for verify loops include `same_validation_twice`, `same_defects_twice`, `unroutable_validation`, `repair_no_progress`, `source_drift_blocked`, `structural_resynthesis_budget`, `local_repair_budget`, and `missing_handoff_artifacts` (post-restore handoff integrity).

## JoinBarrier success path

Research and write groups fan in **only after** a node is marked `status=succeeded`:

1. Engine completes node work and persists handoff/result.
2. For `research` / `write`: `markNodeSucceeded(node)` first so concurrent siblings observe success.
3. Then **once** call `tryJoinAfterSuccess(host, node)`.
4. `tryJoinAfterSuccess` loads siblings via `siblingsByGroupKey`, then `evaluateJoin(members)`:
   - `terminal_failure` → do not expand
   - `not_ready` → wait for remaining siblings
   - `all_succeeded` → queue synthesis (research) or verification (write)
5. `afterSuccess` intentionally no-ops fan-in for research/write so join is not double-fired.

`evaluateJoin` is pure (`join-barrier.ts`). Verify peer completion uses a separate path in `afterSuccess` / `maybeCompleteVerification` after self is marked succeeded.

## Engine shape (facade + pump)

- **Facade**: public API on `WikiWorkflowEngine` — start/resume/cancel, retry node/phase, fork-and-retry, listeners, checkpoint hooks.
- **Pump**: private loop that picks runnable nodes (deps all succeeded), batches researchers/writers/verification, executes, then advances via transitions.
- **TransitionHost**: thin adapter so `transitions-queue` mutates graph without owning the engine class.

## User-visible phases

```
inspect → research → plan → write → verify
```

Node kind → phase mapping (`workflow-phases.ts`):

| Node kind | Phase id | Title |
|-----------|----------|-------|
| `inspect` | `inspect` | Inspect |
| `research` | `research` | Research |
| `synthesis` | `plan` | Plan |
| `write` | `write` | Write |
| `validate` \| `review` \| `finalize` | `verify` | Verify |

UI stage rows (`ui/stages.ts`) always show the full `WIKI_WORKFLOW_PHASES` map, even before the engine has queued every subagent.
