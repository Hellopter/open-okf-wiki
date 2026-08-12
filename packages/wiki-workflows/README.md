# Repository Wiki Producer

`@okf-wiki/wiki-workflows` is a Pi extension that builds and refreshes a
source-grounded repository Wiki. It uses plain streaming command output; there
is no TUI and no generic workflow platform.

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
/wiki status [run-id]
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

## Execution model

The public module is intentionally small: `createProductionWikiProducer()`
returns a producer whose `start()` method returns a `WikiRunHandle`; the handle
exposes `view()`, `events()`, `result()`, and `control()`. Pi commands are a thin
adapter over this interface.

The internal lifecycle is fixed only where determinism matters:

```text
Inspect -> Lead loop -> Validate -> Publish
```

The Lead loop dynamically chooses research scope, fan-out, follow-up questions,
page groups, and verification. It is a Wiki-specific runtime, not a reusable
workflow DSL. Shared admission bounds concurrent Agents, and every session has
a wall-clock deadline.

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

- Pi owns one Agent's model loop, compaction, and tools. Its automatic turn and
  provider retries are disabled.
- The Wiki task runtime is the single retry owner. It owns one bounded fresh
  session retry, concurrency admission, artifact acceptance, and pause/resume.
- Transient 500/502/503/504 and network timeouts receive at most one fresh
  session retry.
- 429 pressure reduces shared admission, honors `Retry-After`, and permits one
  fresh-session retry. Exhaustion becomes an explicit failed task receipt.
- Authentication, billing, invalid request, and exhausted quota failures block
  immediately instead of consuming retry budget.
- A timeout or cancellation aborts and disposes the Agent. Finalized Markdown
  artifacts remain eligible for later context handoff.
- Candidate pages are deterministically validated before the recoverable,
  atomic publication swap.

No compatibility path is retained for the previous DAG snapshots or submission
artifacts. Remove stale `.okf-wiki/` run state before using this version; the
published `wiki/` directory is independent of that run state.
