# Repository Wiki Producer

`@okf-wiki/wiki-workflows` is a Pi extension that builds and refreshes a
source-grounded repository Wiki. There is no generic workflow platform. The
status overlay is a subscriber of `WikiProducer`, not a workflow TUI.

```bash
pnpm build
pi install ./packages/wiki-workflows
```

Run Pi in the repository and use:

```text
/wiki [focus]
/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]
/wiki source add link <local-path> [--name <name>] [--workspace <dir>]
/wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]
/wiki regenerate [focus]
/wiki status [run-id] [task-id] [--process]
/wiki runs
/wiki pause
/wiki resume [run-id]
/wiki cancel [run-id]
```

`/wiki` updates the Wiki and may focus research on the supplied text.
`regenerate` discards the prior page topology and rebuilds it. A Git repository
without `workspace.yaml` is used directly as an implicit single source.

For multiple repositories, run `init` to create an explicit workspace. It
defaults to the current directory, `--lang zh`, standard source ignores, and no
extra excludes. `--exclude` is repeatable. `source add link` accepts only a
local Git repository root and creates a symlink on Linux/macOS or a directory
junction on Windows. `source add clone` clones a local or remote Git URL and can
checkout `--ref`; use it when filesystem links are undesirable or unavailable.
`--name` overrides the derived workspace directory name.

`workspace.yaml` also accepts `wiki.maxConcurrentAgents` (total Lead plus leaf
sessions, default 3), `wiki.transientRetries` (default 1), and
`wiki.baseRetryDelayMs` (default 1000). `language` is passed to Lead and leaf
Agents as the required reader-facing Wiki language.

## Watching a run

While a run is active, the TUI footer and widget show stage and task progress.
`/wiki status` prints a run card. `/wiki status <run> <task>` shows the task
result (receipt and handoff). `--process` prints compact process history.
Enter opens a bordered status overlay; highlighting a task shows its context
stats (turns, tokens, context window). Esc leaves it. The overlay is not
teammate chat.

## Execution model

The public module is intentionally small: `createProductionWikiProducer()`
returns a producer whose `start()` method returns a `WikiRunHandle`; the handle
exposes `view()`, `events()`, `result()`, `control()`, and `inspect()`. Pi
commands are a thin adapter over this interface.

The internal lifecycle is fixed only where determinism matters:

```text
Inspect -> Lead loop -> Validate -> Publish
```

The Lead loop dynamically chooses research scope, fan-out, follow-up questions,
page groups, and verification. It is a Wiki-specific runtime, not a reusable
workflow DSL. Shared admission bounds concurrent Agents, and every session has
a wall-clock deadline. Each Lead and delegated Agent receives a fresh Pi
session with auto-compaction enabled. Compaction summarizes older context when
the session approaches its context limit and preserves recent work.

Research content is stored outside conversation context as content-addressed
Markdown blobs referenced by compact task receipts:

```text
.okf-wiki/blobs/<sha256>.md
.okf-wiki/runs/<run-id>/manifest.json
```

The blob contains model-readable analysis. The durable receipt contains only
status, gaps, failure metadata, and the artifact reference. Downstream Agents
receive accepted references and retrieve only the context they need.

## Reliability

- Pi owns one Agent's model loop, compaction, and tools. Auto-compaction is
  always enabled with Pi's in-memory defaults (`reserveTokens: 16384`,
  `keepRecentTokens: 20000`). Pi itself exposes `compaction.enabled`,
  `compaction.reserveTokens`, and `compaction.keepRecentTokens` settings, but
  the Wiki runtime does not expose them in `workspace.yaml` or inherit project
  or user Pi settings.
- Pi automatic turn and provider retries are disabled.
- The Wiki task runtime is the single retry owner. It owns configurable bounded
  fresh-session retries, concurrency admission, artifact acceptance, and
  pause/resume.
- Transient 500/502/503/504 and network timeouts use the configured retry count.
- 429 pressure reduces delegated admission, honors `Retry-After`, and uses the
  same retry limit. Exhaustion becomes an explicit failed task receipt.
- Authentication, billing, invalid request, and exhausted quota failures block
  immediately instead of consuming retry budget.
- A timeout or cancellation aborts and disposes the Agent. Finalized Markdown
  artifacts remain eligible for later context handoff.
- Candidate pages are deterministically validated before the recoverable,
  atomic publication swap.

No compatibility path is retained for the previous DAG snapshots or submission
artifacts. Remove stale `.okf-wiki/` run state before using this version; the
published `wiki/` directory is independent of that run state.
