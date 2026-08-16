# Repository Wiki Producer

`@okf-wiki/wiki-workflows` is a Pi extension that fully generates a
source-grounded repository Wiki. There is no generic workflow platform. The
status overlay is a subscriber of `WikiProducer`, not a workflow TUI.

```bash
pnpm build
pi install ./packages/wiki-workflows
```

The host skill `repository-wiki-producer` is the only model-facing skill. It
ships in the package (`pi.skills`) and is loaded by `pi install`, not from the
repository `.agents/` directory. Production `wiki-production/SKILL.md` is the
Lead session brief, copied into the run directory. Worker roles are
`briefs/*.md`, not skills. Templates are disclosed references.

Run Pi in the repository and use:

```text
/wiki [focus]
/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]
/wiki source add link <local-path> [--name <name>] [--workspace <dir>]
/wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]
/wiki status [run-id] [lead|batch-N/task-id] [--process]
/wiki runs
/wiki pause
/wiki resume [run-id]
/wiki cancel [run-id]
```

Every `/wiki` invocation starts an isolated full generation in a fresh empty
Candidate. Optional focus prioritizes research without dropping essential
coverage. A Git repository
without `workspace.yaml` is used directly as an implicit single source.

For multiple repositories, run `init` to create an explicit workspace. It
defaults to the current directory, `--lang zh`, standard source ignores, and no
extra excludes. `--exclude` is repeatable. `source add link` accepts only a
local Git repository root and creates a symlink on Linux/macOS or a directory
junction on Windows. `source add clone` clones a local or remote Git URL and can
checkout `--ref`; use it when filesystem links are undesirable or unavailable.
`--name` overrides the derived workspace directory name.

The `wiki` section controls the Agent runtime:

```yaml
wiki:
  exclude: []
  maxConcurrentAgents: 3
  transientRetries: 1
  baseRetryDelayMs: 1000
  sessionTimeoutSeconds: 1200
  maxDelegatedTasks: 24
  maxDelegateBatches: 8
  maxTurnsPerSession: 60
  maxToolCallsPerSession: 120
  models: {}
  generation:
    audience: [maintainers, integrators]
    purpose: Explain the system's domains, behavior, and extension points.
    focus:
      include: [architecture, runtime behavior, public contracts]
      exclude: [generated files]
    granularity:
      preferChildPagesFor: [flows, states, data structures]
    templates:
      requiredSections: [Overview, Source evidence]
    review:
      mustCover: [cross-domain links, operational flows]
```

All execution limit values are integers:

| Setting | Default | Valid range | Meaning |
| --- | ---: | ---: | --- |
| `maxConcurrentAgents` | `3` | `2..64` sessions | Total concurrent model sessions, including the Lead and delegated Agents. |
| `transientRetries` | `1` | `0..10` retries | Fresh-session retries for each transient Lead or delegated Agent failure; `0` disables them. |
| `baseRetryDelayMs` | `1000` | `0..300000` ms | Full-jitter exponential backoff base when the provider supplies no `Retry-After`; `0` removes the local delay. |
| `sessionTimeoutSeconds` | `1200` | `1..2147483` seconds | Wall-clock deadline applied separately to every Lead and delegated Agent session. |
| `maxDelegatedTasks` | `24` | `1..10000` tasks | Maximum delegated tasks started across the complete run, including resumed work but excluding retries. |
| `maxDelegateBatches` | `8` | `1..1000` batches | Maximum asynchronous delegation batches started across the complete run. |
| `maxTurnsPerSession` | `60` | `1..100000` turns | Hard limit for model turns in each Lead or delegated Pi session. |
| `maxToolCallsPerSession` | `120` | `1..1000000` calls | Hard limit for tool calls in each Lead or delegated Pi session. |

Timeouts count as transient failures and consume the same retry budget. Provider
`Retry-After` values take precedence over the configured backoff base.
Task and batch limits are run-wide and remain consumed after pause/resume.
Turn and tool-call limits are enforced per persistent Pi session. Token, cost,
cache, and context-window usage are reported for observation but are not hard
limits.

`models` optionally overrides the Pi model for any of `lead`, `research`,
`write`, and `review`. Omitted roles inherit the model and thinking level active
when the Wiki run starts. Each override requires a Pi registry `provider` and
`id`; `thinkingLevel` is optional and accepts `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`:

```yaml
wiki:
  models:
    research:
      provider: your-provider
      id: your-model-id
      thinkingLevel: high
```

Configured model identifiers must already exist in the active Pi model
registry. A resumed session restores its persisted model instead of silently
switching to a newly configured model.

`language` is required for reader-facing Wiki pages and writer/reviewer
handoffs. Research briefs are model-readable analysis and do not have to use
that language.

`generation` is optional. Its fields guide topology and content rather than
changing runtime limits: `audience` and `purpose` define the reader contract;
`focus` scopes coverage; `preferChildPagesFor` asks the planner to split those
subjects into dedicated pages; `requiredSections` is enforced both before write
and at final validation; and `mustCover` is required in the structured review.
Unknown fields are rejected.

## Wiki topology

The Lead submits a WikiSpec page path list with `wiki_plan` before any page
can be written. The host derives pageType and cluster identity from those
paths. A published Wiki uses this cluster topology:

```text
wiki/
  index.md                 # host
  overview.md
  architecture.md          # optional
  <domain>/
    index.md
    domain.md
    <concept>/
      concept.md
      models.md / flows.md / sequences.md / states.md / data.md / modules.md
```

Page paths sit beside their concept. There are no type-bucket directories
(`concepts/`, `flows/`). Indexes are deterministic host-owned projections, not
model-authored pages. The Published Wiki and final WikiSpec are provenance
only; neither seeds a new Run's topology or content.

## Watching a run

While a run is active, the TUI footer and six-line widget keep the Leader,
current activity, liveness, context pressure, and current delegation batch visible.
`/wiki status` opens the run workbench. Use `lead` or `batch-N/task-id` to inspect
an unambiguous Agent.
The overlay uses a two-column navigator and inspector at 100 columns or wider,
and layered single-column navigation on smaller terminals. Overview, Process,
and Output tabs share the same durable transaction view. Esc leaves it. The overlay is not
teammate chat.

## Execution model

The public module is intentionally small: `createProductionWikiProducer()`
returns a producer whose `start()` method returns a `WikiRunHandle`; the handle
exposes `view()`, `updates()`, `result()`, `control()`, and `inspectAgent()`.
Agent inspection is a point query; there is no run-level activity log. Pi
commands are a thin adapter over this interface.

Each Workspace admits one non-terminal Run; different Workspaces may run in
parallel. The internal lifecycle is fixed where determinism matters:

```text
Inspect -> Spec plan -> Lead/Writer loop -> Review -> Validate -> Publish
```

The Lead loop dynamically chooses research scope, fan-out, follow-up questions,
page groups, and verification. It is a Wiki-specific runtime, not a reusable
workflow DSL. Shared admission bounds concurrent Agents, and every session has
a wall-clock deadline. Run settings and Source identities are pinned on the
first attempt. Lead and delegated attempts use persistent Pi sessions
with auto-compaction; pause/resume reopens the exact session with its saved
model, thinking level, messages, tool results, and compaction history.
Resume preserves the Candidate and pinned settings; Source drift fails the Run.
Compaction summarizes older context when the session approaches its context
limit and preserves recent work.

The Lead may write directly only for a one-domain Spec with at most three
content pages and no compaction. Otherwise the Lead writes by cluster through
delegated Writers. Any Lead compaction permanently disables direct writes for
that run. Review is always independent. Research is delegated only when the
scope needs parallel coverage or the Lead cannot cover it.

The host projects remaining work to a read-only
`.okf-wiki/runs/<id>/board.md`. The Lead reads that board after compaction and
before every dispatch or finish.

Writer output is parsed, source-checked, link-checked,
and YAML-canonicalized in process before an atomic replacement; no external
`yamlformatter` executable is required. Reviewers receive exact read-only page
and generated-index paths. Their structured result is accepted only for the
captured Spec and write revisions, so later writes invalidate earlier passes.

Research content is stored outside conversation context as content-addressed
Markdown blobs referenced by compact task receipts:

```text
.okf-wiki/blobs/<sha256>.md
.okf-wiki/runs/<run-id>/manifest.json
```

The blob contains model-readable analysis. The durable receipt contains only
status, gaps, failure metadata, and the artifact reference. Downstream Agents
receive accepted references and retrieve only the context they need. Blob bytes
and the per-Run manifest are fsynced before a receipt can commit. They remain
after successful publication as durable handoff and audit evidence; identical
content may share a content-addressed blob.

## Reliability

- Pi owns one Agent's model loop, persistent session, skill loading,
  compaction, cancellation, usage statistics, and tool execution. Auto-compaction is
  always enabled with Pi's in-memory defaults (`reserveTokens: 16384`,
  `keepRecentTokens: 20000`). Pi itself exposes `compaction.enabled`,
  `compaction.reserveTokens`, and `compaction.keepRecentTokens` settings, but
  the Wiki runtime does not expose them in `workspace.yaml` or inherit project
  or user Pi settings.
- Pi automatic turn and provider retries are disabled.
- The Wiki task runtime is the single retry owner. It owns asynchronous
  start/collect/cancel batches, configurable bounded fresh-session retries,
  concurrency admission, artifact acceptance, and durable pause/resume.
- Transient 400/500/502/503/504 and network timeouts use the configured retry count.
- 429 pressure reduces delegated admission, honors `Retry-After`, and uses the
  same retry limit. Exhaustion becomes an explicit failed task receipt.
- Authentication, billing, local schema/validation, and exhausted quota failures
  block immediately instead of consuming retry budget.
- A timeout or cancellation aborts and disposes the Agent. Finalized Markdown
  artifacts remain eligible for later context handoff.
- Candidate pages are deterministically validated before replacement. Final
  governance issues an opaque seal over the Run, Candidate root, complete tree
  digest, page set, and WikiSpec; publication verifies it again immediately
  before the recoverable, atomic swap.
- Publication requires complete, current independent review coverage. Missing,
  stale, or `changes_requested` results fail closed.
- Workspace and attempt leases prevent concurrent execution of one Workspace
  across processes. Publication has a distinct Workspace lease so recovery
  waits for a live publisher and only reclaims a dead owner.
- The materialized production skill is a complete, fsynced Run snapshot. Its
  exact tree digest is pinned in the Run plan and verified on resume.

The current format is 1; anything else fails closed. New publications write
version 1, including the source fingerprint, summary, sealed WikiSpec, tree
digest, and page set. The active publication journal binds that canonical
metadata with a digest. Once the matching Run terminal transition is durable,
acknowledgement archives the journal under
`.okf-wiki/publications/<run-id>.json`; archived journals remain auditable but
are excluded from later recovery. Run and publication filesystem transitions
fsync both file contents and changed directory entries before advancing their
durable state.

Preserve needed evidence and remove stale `.okf-wiki/` Run state manually; the
Published Wiki is independent of that state. A successful current-version Run
removes its transient Candidate,
session, transaction, publication preimage, and materialized skill after
publication. It retains content-addressed artifacts, the per-Run artifact
manifest and receipts, Run state, published provenance, and the acknowledged
publication audit.
