# Wiki Producer architecture

## External seam

The producer returned by `createProductionWikiProducer()` is the deep module.
Its interface is the complete caller surface:

```ts
const run = await producer.start({ cwd, operation: "update", focus });
for await (const event of run.events()) renderWikiEvent(event);
await run.control("pause");
await run.control("resume");
const result = await run.result();
```

Callers do not know node kinds, graph dependencies, research rounds, page
writers, retry attempts, candidate paths, or publication journals. Pi extension
commands and tests use the same interface.

Workspace mutation is a separate small module used only by `/wiki init` and
`/wiki source add`. It validates Git roots, source names and destinations, then
atomically updates `workspace.yaml`; it is not part of the production run seam.

## Implementation

The producer hides four deterministic gates around one dynamic Lead loop:

```text
workspace ownership
  -> inspect pinned source state
  -> Lead research/write loop
  -> deterministic Wiki validation
  -> atomic publication and recovery
```

The Lead owns the evolving research strategy. It may use one Agent for a small
repository, fan out independent packages, continue targeted gaps, verify
conflicts, and group related pages under one writer. Completion is based on
coverage and accepted evidence, not completion of a predefined DAG.

There is deliberately no workflow scripting interface, generic task graph,
plugin system, saved workflow, arbitrary nested Agent recursion, or public
node retry. This keeps policy, recovery, and tests local to the Wiki domain.

## Internal seams

Only dependencies that genuinely vary receive adapters:

- `WikiLeadRuntime`: an internal production Pi Lead loop and deterministic test fake.
- Filesystem-backed stores: production directories and temporary test roots.
- Clock/ID injection for deterministic run tests.

Inspection, evidence acceptance, path authorization, Wiki validation, workspace
ownership, and publication are Wiki implementation, not interchangeable public
adapters. Pi supplies Agent sessions plus the standard read/grep/find/ls and
write/edit implementations. The Wiki layer only applies readable roots,
attempt-local path remapping, exact write sets, symlink defense, and output
bounds.

## Artifact handoff

Model-authored prose is data, not workflow control state:

- Content-addressed Markdown blob: concise narrative for downstream Agents.
- Artifact reference: hash, media type, and bounded size.
- Task receipt: small status envelope with gaps, failures, and artifact refs.

The host validates size and integrity, then content-addresses accepted handoff
artifacts. Run state retains receipts and references, never large research prose.
Missing/failed branches are recorded as missing coverage rather than negative
findings.

## Observability

Progress is a projection of run events, not a control plane. It does not
admit work, retry tasks, or publish the Wiki.

Delegated receipts and compact process history live in a sidecar at
`.okf-wiki/runs/<id>/tasks/<taskId>.json`. `inspect()` reads that sidecar and
the content-addressed Markdown blob. The `/wiki status` card, TUI
footer/widget, and status overlay subscribe to `view()` and `inspect()`.

Do not restore the former DAG, TUI renderer, or public node retry. The overlay
is a Wiki-specific subscriber of `WikiProducer`.

## Context policy

Every Lead and delegated Agent runs in a fresh in-memory Pi session with
auto-compaction enabled. Pi triggers compaction as the session approaches its
context limit, summarizes older messages, and keeps recent work. The Wiki
runtime currently uses Pi's defaults of `reserveTokens: 16384` and
`keepRecentTokens: 20000`. Pi itself makes the enable flag and both thresholds
configurable, but the Wiki runtime neither exposes them in `workspace.yaml` nor
inherits project or user Pi settings.

Compaction is an intra-session context mechanism. It does not replace the
content-addressed artifact handoff between independent Agent sessions.

## Failure policy

Retry has one owner. Pi turn auto-retry and provider retry are explicitly
disabled. The Wiki task runtime owns the configured fresh-session retry budget
for recoverable Agent failures.

500-class transient failures and timeouts use exponential backoff with full
jitter. 429 reduces shared admission, honors reset metadata, and receives at
most `wiki.transientRetries` fresh-session retries. Exhaustion remains an
explicit failed task receipt. 401/403, billing, invalid request, and hard quota
errors are non-retryable; quota and usage-limit outcomes durably pause the run.

Pause aborts in-flight Agent sessions after persisting accepted artifacts.
Resume preserves the candidate and accepted content-addressed artifacts, then
re-inspects source before publication. Source drift rejects the run. Publication
has its own rename journal because
generic run persistence cannot guarantee an atomic Wiki swap.

## Deleted design

The former engine/application/DAG/transition/join modules, fixed phases,
research catalog queries, staged JSON submission tools, node/phase retry UI,
TUI renderer, and version-2 snapshot protocol are not part of this design and
have no compatibility path. Tests are replaced at the `WikiProducer` interface;
they do not assert internal graph transitions.
