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

## Failure policy

Retry has one owner. Pi turn auto-retry and provider retry are explicitly
disabled. The Wiki task runtime may start at most one fresh session for a
recoverable Agent failure.

500-class transient failures and timeouts use exponential backoff with full
jitter. 429 reduces shared admission, honors reset metadata, and receives at
most one fresh-session retry. Exhaustion remains an explicit failed task
receipt. 401/403, billing, invalid request, and hard quota errors are
non-retryable; quota and usage-limit outcomes durably pause the run.

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
