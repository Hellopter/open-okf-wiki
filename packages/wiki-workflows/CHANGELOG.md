# Changelog

All notable changes to `@okf-wiki/wiki-workflows` are documented in this file.

## [Unreleased]

### Behavior

- **Domain-first Wiki depth.** Every configured/evidence-derived domain has a
  required aggregation page plus reader questions and required facets. State
  and data pages are first-class types. Workspace terminology, excludes,
  configured domains, and concurrency are pinned into each run and enforced.
- **Sequential quality gates.** Writers repair deterministic format, citation,
  link, and Mermaid failures in-session. Semantic review starts only after the
  candidate passes static validation.
- **Bounded structured handoff.** Research, synthesis, and review accumulate
  typed fragments through bounded mutation and paginated query tools, then use
  a small terminal submission for acceptance. Plan uses separate expand and
  finalize tools with a shared configurable one-to-three-attempt terminal
  budget. Canonical artifacts remain complete content-addressed JSON; giant
  repeated tool payloads and Agent-authored JSON/Markdown handoff files are
  removed.
- **Review fan-out and safe page acceptance.** Semantic review runs once per
  domain and then globally aggregates cross-domain concerns. Writers use
  attempt-local working pages; only sealed, validated bytes are atomically
  promoted into the candidate.
- **Bounded Pi runtime.** Isolated sessions use fixed native compaction and a
  configurable `1..16` agent-level retry budget,
  a bounded configurable fresh-session count for overflow/transient exhaustion,
  a bounded node deadline and 429 cooldown, dynamic concurrency, and active
  memory protection.
- **Explicit attempt accounting.** A durable node attempt is one fresh Pi
  session. `maxAutoRetries` counts retries after an initial model request and
  uses Pi's uncapped 2-second exponential backoff. Node deadlines include retry
  waits; correction turns and tool continuations are additional requests, so
  node attempts are not billing-call counts.
- **Pinned configuration lifecycle.** New runs pin normalized terminology,
  exclusions, configured domains, submission count, concurrency, deadline,
  transient-session count, cooldown, and prompt identity. Config edits never
  hot-patch executing nodes; resuming a paused run with a changed policy hash
  atomically re-pins it and restarts from Inspect. Research-round quality
  remains fixed from run start.
- **Source citation guidance + fix hints.** Writer prompts include a full frontmatter/`[^id]`/footnote golden example and anti-patterns. High-frequency `source-reference` validation messages append short remediation after ` — ` so submit/repair feedback tells agents how to fix pairing errors.
- **Run control triad: pause / stop / cancel.** Soft `pause` still only stops scheduling (active agents may finish; status shows draining). New hard-stop-resume via `engine.stop()`, `/wiki stop`, and navigator `s` (confirm): abort live agents, requeue them, leave the run `paused` and resumable. `cancel` remains terminal. Session `interrupt` shares the same hard-stop-resume helper.
- **Richer research/planning prompts (no new pipeline stage).** Survey tasks and research guidance use survey-then-deepen with finer findings; synthesis prefers entity-cluster multi-page Spec paths (`modules/` / `flows/` / `concepts/`); templates and review notes push depth and topology without enrich rounds or nested subagents.

### Architecture

- **Candidate and recoverable publication.** Runs write only to
  `.okf-wiki/runs/<runId>/candidate/wiki`; refresh retains unchanged Markdown,
  forks copy accepted candidates, and an atomic journal swap publishes only
  after source drift checks. Startup and ordinary I/O failures recover pending
  journals.
- **Workspace-local run ownership.** `run.json` is authoritative, the summary
  index is derived, and history/artifact cleanup cannot remove candidate,
  journal, or backup data. Symlink traversal fails closed.
- **Session pointer-only.** Pi custom entries (`WikiRunSession`) are pointer-only (`pointerVersion: 1`, `runId`, `revision`, `status`, `updatedAt`, `workspace`). Full `WikiRunSnapshot` bodies live in the project history store. Legacy full-snapshot session entries are rejected fail-closed (no dual-read). Restore path: parse pointer → `historyStore.load(runId)` → `engine.restore(snapshot)`. Host session appends only on critical events (not `node_activity` / `node_started`).
- **Artifact-backed durable receipts.** Full accepted node results are immutable
  content-addressed artifacts. Run snapshots store bounded routing receipts,
  hashed input fingerprints, and strict owner/attempt references; restore fails
  closed on missing or mismatched artifacts and hydrates results before resume.
- **Snapshot v1 baseline — no migration.** Durable run snapshots and their pinned policy start at `version: 1`. Pre-release history with another shape is **rejected** fail-closed; clear stale `.okf-wiki/` and run `/wiki generate`.
- **Recovery / retry.** Interrupted (`running`/`paused`) history can be forked for retry; UI `waitAgentSettle` only when the active engine still has a live node controller.
- **Research stop.** Expand hard-rejected without critical gaps; expand scopes must reference gap questions; dry audit skipped when no critical gaps; dry fingerprints normalize evidence paths.
- **JoinBarrier success path.** Research and write fan-in no longer races on concurrent batch completion. After a node is marked `status=succeeded`, the engine calls `tryJoinAfterSuccess` once; pure `evaluateJoin` / `siblingsByGroupKey` (`join-barrier.ts`) decide `not_ready` vs `all_succeeded` before queueing synthesis or verification. The historical `reconcileCompletedBatch` re-entry path is gone.
- **Research budget split; `requiredDryCoverageAudits` default 1.** Policy splits expand vs audit accounting (`maxExpandRounds`, `maxAuditRounds`, `requiredDryCoverageAudits`). Happy path requires a single consecutive dry coverage audit before writers are queued (default `requiredDryCoverageAudits: 1`). Budget exhaustion surfaces as typed codes (`research_rounds_exhausted`, `expand_rounds_exhausted`, `audit_rounds_exhausted`), not message regex.
- **`blockedDetails` diagnostics.** Terminal blocked runs may carry structured `blockedDetails` (`code`, `issues`, `defects`, `page`, remaining budget, …) for UI and ops without a snapshot version bump.
- **Restore artifact health check.** After accepting a valid snapshot, `checkRunArtifactHealth` verifies succeeded research/synthesis/review handoffs are still readable from the artifact store so resume cannot dispatch into a graph with missing blobs (`missing_handoff_artifacts`).
- **Module split (engine thinner).** Graph transitions, join fan-in, phase labels, node parsers, and checkpoint coordination live in focused modules (`transitions-queue`, `join-barrier`, `workflow-phases`, `run-nodes`, `run-graph`, `checkpoint`, `run-health`, …). `engine.ts` remains the facade + pump; behavior is delegated rather than monolithic.
