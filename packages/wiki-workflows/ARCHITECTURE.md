# wiki-workflows architecture

Git-native repository Wiki DAG workflow for Pi. The engine owns run state; pure modules own policy, phase labels, graph helpers, and join fan-in. UI and extension layers are adapters.

## Module map

| Module | Role |
|--------|------|
| `src/policy.ts` | Product budgets plus resolved, hashable per-run workspace policy (exclude, terminology, configured domains, concurrency, prompt bundle). |
| `src/failures.ts` | Failure codes, `WikiFailure` / `WikiFailureClass`, `WikiBudgetExhaustedError`, `errorMessage`. Single source for `WikiNodeErrorCode`. |
| `src/util.ts` | Pure helpers: `isRecord`, `clone`, `pathIsInside`, `uniqueStrings`, `stableStringify`; re-exports `errorMessage`. |
| `src/workflow-phases.ts` | User-visible phases. Static validation remains in Write; semantic review and finalization map to Review & Publish. |
| `src/workflow-types.ts` | Runtime and durable snapshot / node / event types (`WikiRunSnapshot` **version 1**, pinned policy and `blockedDetails`). |
| `src/node-retry.ts` | Pure classification of execution errors → node status / terminal run. |
| `src/join-barrier.ts` | Sibling join helpers: `evaluateJoin`, `groupAllSucceeded`, `siblingsByGroupKey`. Success path only (see below). |
| `src/session.ts` | Pointer-only Pi custom-entry codec (`WikiRunSession` / `createWikiRunSession` / `parseWikiRunSession`). Fail-closed; **no legacy full-snapshot dual-read**. |
| `src/checkpoint.ts` | Debounced, serialized session (pointer) + history (full snapshot) checkpoint coordinator (`WikiCheckpointCoordinator`). |
| `src/engine.ts` | Wiki DAG **facade + pump**: owns run state, scheduling, retries, terminalization; delegates transitions to `transitions-queue` via `TransitionHost`. |
| `src/transitions-queue.ts` | Per-kind success transitions, graph expansion (`queue*`, `ensure*`, join fan-in via `tryJoinAfterSuccess`), terminal block policy with `blockedDetails`. Host-injected; no executor/Pi. Research stop: expand hard-rejected without critical gaps; dry audits skipped on happy path when receipts report no unresolved critical gaps. |
| `src/run-nodes.ts` | Node input/result parsers (`ResearchNodeInput`, `SynthesisNodeInput`, `PagePacketInput`, `WikiNodeInputByKind`, `parseNodeInput`), fingerprints, repair/write packet helpers, validation issue routing. |
| `src/run-graph.ts` | Phase membership, fork/invalidate closure, terminal checks; `phaseTitleFor` delegates to `workflow-phases`. |
| `src/prompts.ts` | Agent prompt builders for research / synthesis / write / review. |
| `src/path-policy.ts` | Safe path resolution for wiki and source trees. |
| `src/submissions/contracts.ts` | Model-facing typed-object contracts shared by submission tools and prompts. |
| `src/wiki-validate.ts` | Deterministic page/tree validation performed during Write and again before publication. |
| `src/wiki-indexes.ts` | Index page materialization helpers. |
| `src/wiki-finalize.ts` | Finalization (indexes, obsolete pages) after static validation and semantic review pass. |
| `src/validate.ts` | Facade re-exporting inspect/validate/finalize entry points used by the engine. |
| `src/artifact-store.ts` | Content-addressed accepted-object and coordinator-report blobs with per-run manifests. |
| `src/publication-store.ts` | Per-run candidate trees, fork copy, atomic publish journal, rollback and startup recovery. |
| `src/run-history.ts` | Workspace-local authoritative `run.json`, derived index, pagination and retention. |
| `src/workspace-coordinator.ts` | Local PID/token ownership, atomic acquisition, and dead-process reclamation for workspace mutations. |
| `src/snapshot-validation.ts` | Fail-closed version 1 checks, including policy/hash and artifact-reference consistency. |
| `src/executor.ts` | Isolated Pi sessions, compaction/retry policy, runtime admission, bounded streams/history, and node deadline. |
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
- Snapshot `version` is **1**. Incompatible shapes are **rejected** (fail closed) by `snapshot-validation.ts` (no migration).
- Session restore is **pointer-only**; full snapshots live in the project history store.
- Artifacts are **content-addressed** under `.okf-wiki/blobs/{sha256}.*` with per-run manifests (no dual-read of older layouts).
- Full node payloads stay in artifacts. Durable nodes carry bounded receipts and
  exact artifact references; restore validates ownership and hydrates full
  results before resumed scheduling.
- Optional `blockedDetails` on terminal blocked runs carries structured diagnostics (`code`, `issues`, `defects`, `page`, …).

## Workspace policy lifecycle

`workspace.yaml` has two run-control groups:

| Field | Default | Validation / ownership |
|-------|---------|------------------------|
| `quality.maxResearchRounds` | `6` | Integer `3..20`; copied into the run only at start |
| `quality.maxSubmissionAttempts` | `3` | Integer `1..3`; terminal acceptance calls per node attempt; pinned policy |
| `wiki.exclude` | `[]` | Non-empty string globs; global inspection and accepted-evidence exclusion |
| `wiki.terminology` | `{}` | Non-empty string keys and definitions; prompt-visible canonical vocabulary |
| `wiki.domains` | `[]` | Unique safe ids, non-empty titles, required non-empty include arrays, optional exclude arrays |
| `wiki.runtime.maxConcurrentAgents` | `2` | Integer `1..4`; shared engine/executor admission limit |
| `wiki.runtime.nodeTimeoutSeconds` | `1200` | Integer `60..1800`; isolated session wall-clock deadline |
| `wiki.runtime.maxAutoRetries` | `3` | Integer `1..16`; agent-level retries after the initial request |
| `wiki.runtime.maxTransientSessionAttempts` | `2` | Integer `1..2`; total sessions for transient/context/deadline classes |
| `wiki.runtime.rateLimitCooldownSeconds` | `15` | Integer `15..120`; admission cooldown after provider pressure |

At `engine.start`, `resolveWikiPolicy` normalizes ordering and duplicates, adds
the policy and prompt-bundle versions, hashes the result, and stores both value
and hash in the version 1 snapshot. Nodes read `run.policy`; they do not reload
configuration, so an edit cannot change an executing agent or half of a batch.
On resume, the extension loads the current workspace policy and calls
`reconcilePolicy`. A changed hash replaces the pinned policy as one atomic run
transition, invalidates from Inspect, and requeues Inspect before dispatch.
`quality.maxResearchRounds` remains the value originally stored on that run;
`quality.maxSubmissionAttempts` participates in the pinned policy hash.

Configured domain include patterns select declared source roots and fail closed
when no root matches. They do not create a finer filesystem sandbox within that
source root. Domain excludes are task-specific research guidance; global
`wiki.exclude` is the deterministic exclusion enforced when research evidence
and Wiki citations are accepted.

## Research budgets

Policy splits expand vs audit accounting (`policy.research`):

| Field | Default | Meaning |
|-------|---------|---------|
| `maxExpandRounds` | 4 | Coverage-growth rounds (tighter happy path) |
| `maxAuditRounds` | 3 | Dry-coverage audit rounds |
| `requiredDryCoverageAudits` | 1 | Consecutive dry audits required before write **when unresolved critical gaps remain** |
| `maxResearchRounds` | 6 | Legacy combined ceiling still used by the current engine pump until split accounting is fully wired |

**Research stop (happy path):** when every research receipt in the Plan’s `researchIds` has `criticalGapSignatures.length === 0`, synthesis **must finalize** (expand is hard-rejected) and the engine **skips** the dry-coverage audit wave, queueing page writers immediately. Dry audits still run only when critical gaps remain. Expand scopes must **bind** to unresolved critical gap questions in `id`/`task`. Dry-audit finding fingerprints use kind + title + evidence **paths** (line anchors stripped) so line-number jitter does not keep audits wet.

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
4. `tryJoinAfterSuccess` loads siblings via `siblingsByGroupKey` (**excludes `invalidated`** so deterministic group ids reused after source-drift restart do not stall), then `evaluateJoin(members)`:
   - `terminal_failure` → do not expand
   - `not_ready` → wait for remaining siblings
   - `all_succeeded` → queue synthesis (research) or verification (write)
5. `afterSuccess` intentionally no-ops fan-in for research/write so join is not double-fired.

`evaluateJoin` is pure (`join-barrier.ts`). Validation and semantic review are
sequential gates: validation repairs route immediately, then a clean candidate
fans out one reviewer per non-Overview domain. A global reviewer depends on all
domain fragments and owns cross-domain, Overview, and topology findings. Only
the clean aggregate queues finalization; any repair creates a fresh full review
generation.

## Engine shape (facade + pump)

- **Facade**: public API on `WikiWorkflowEngine` — start/resume/cancel, retry node/phase, fork-and-retry, listeners, checkpoint hooks.
- **Pump**: private loop that picks runnable nodes (deps all succeeded), batches researchers/writers/verification, executes, then advances via transitions.
- **TransitionHost**: thin adapter so `transitions-queue` mutates graph without owning the engine class.

## Candidate and publication ownership

- One local Pi process owns workspace mutations at a time through
  `.okf-wiki/active.lock`; terminal, paused, stopped, and cancelled transitions
  release ownership only after their authoritative snapshot is durable.
- Startup scans fresh project history independently of Pi's session pointer.
  A unique interrupted run is restored as paused; ambiguity is surfaced for
  explicit selection. Live PIDs and malformed ownership records fail closed.
- The coordinator intentionally has no network lease, heartbeat, TTL, or force
  takeover. It is a local single-user guard and never steals a long-running
  process merely because a lock is old.

- Agents never mutate published `wiki/`. Logical `wiki/*` tool paths map to
  `.okf-wiki/runs/<runId>/candidate/wiki`.
- Generate seeds only assets; refresh seeds the complete published tree so
  retained Markdown survives partial rewriting.
- Forked validation/review retries copy the accepted candidate before retaining
  succeeded writer nodes.
- Finalization rechecks source state before and after candidate stamping, then
  the publication store swaps directories with a recoverable journal.
- History deletion owns `run.json`; artifact cleanup owns its manifest/staging.
  Neither may remove publication journals, candidates, or backups.

## Runtime bounds

- Each node gets a fresh in-memory Pi session with native compaction enabled,
  bounded provider retry, the configured deadline (default 20 minutes), and
  bounded stream/history tails.
- Durable `node.attempt` counts fresh Pi sessions. Context overflow, deadline,
  and exhausted transient provider errors use `maxTransientSessionAttempts`
  (default two, range one to two). Validator-infrastructure failures may reach
  the internal three-session node ceiling.
- Pi auto-retry is a separate inner layer: `maxAutoRetries` defaults to `3` and
  accepts `1..16`; provider-library retries are disabled. Pi 0.82.1 uses
  uncapped, jitter-free exponential backoff `2s * 2^(attempt-1)`. The node
  deadline includes these waits and can stop the loop before its retry budget.
- That product is not a total request/cost bound. One missing-submission
  correction turn and tool continuations are additional requests with their own
  Pi retry allowance. If correction still produces no submission, one fixed
  protocol-recovery session is allowed independently of the provider/context
  fresh-session bound. Typed submission
  tools permit the configured `1..3`
  submission calls per node attempt (default `3`); they do not create fresh
  sessions.
- Plan exposes separate `wiki_submit_synthesis_expand` and
  `wiki_submit_synthesis_finalize` tools with one shared submission budget. The
  internal result remains a discriminated synthesis decision; the model does
  not have to satisfy a multi-branch union schema in one tool.
- Research, Plan, and Review use a staged accumulator rather than one monolithic
  model response: at most 128 successful mutations, batches of at most 20
  findings or defects, 24 KiB paginated query responses, and 256 KiB canonical
  artifacts. Terminal submission attempts are accounted separately.
- Writers edit one attempt-local page. Acceptance seals the bytes, validates the
  sealed page, and atomically promotes it into the candidate, so cancellation,
  timeout, and concurrent late writes cannot alter accepted content.
- The resolved concurrency limit is shared by the engine and executor. 429
  pressure temporarily reduces admission to one. Active memory pressure pauses
  and requeues running nodes before the V8 hard threshold.

## User-visible phases

```
inspect → research → plan → write → review
```

Node kind → phase mapping (`workflow-phases.ts`):

| Node kind | Phase id | Title |
|-----------|----------|-------|
| `inspect` | `inspect` | Inspect |
| `research` | `research` | Research |
| `synthesis` | `plan` | Plan |
| `write` | `write` | Write |
| `validate` | `write` | Write |
| `review` \| `finalize` | `review` | Review & Publish |

UI stage rows (`ui/stages.ts`) always show the full `WIKI_WORKFLOW_PHASES` map, even before the engine has queued every subagent.
