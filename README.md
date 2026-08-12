# Open OKF Wiki

Open OKF Wiki is a Pi extension that produces a source-grounded repository Wiki
from one repository or an existing multi-source `workspace.yaml`.

```bash
pnpm install
pnpm build
pi install ./packages/wiki-workflows
```

Run Pi in the repository or Wiki workspace:

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

The default command updates the Wiki. `regenerate` rebuilds its page topology.
A Git repository without `workspace.yaml` works directly as one implicit source.
Use `init` only to create an explicit workspace, then add one or more sources.

`source add link` requires a local Git repository root. It creates a symlink on
Linux/macOS and a directory junction on Windows. Use `source add clone` when a
link is unsuitable or the source is remote; `--ref` checks out a branch, tag, or
commit. `init` defaults to the current directory, Chinese output, and standard
source ignores. Repeat `--exclude` for workspace-specific source globs.

Progress is emitted as plain text. Runs are durable and can be inspected,
paused, resumed, or cancelled without a TUI.

## Design

The package exposes one production factory and a small run interface. The
producer owns the complete Wiki lifecycle:

```ts
const producer = createProductionWikiProducer();
const handle = await producer.start({ cwd, focus });

for await (const event of handle.events()) {
  console.log(event.message);
}

const result = await handle.result();
```

The outer lifecycle keeps deterministic repository and publication work in
code:

```text
Inspect -> dynamic Lead loop -> Validate -> Publish
```

The Lead loop adapts research fan-out, targeted follow-ups, verification, and
page grouping to the repository. It is intentionally Wiki-specific; the project
does not ship a generic workflow DSL or depend on Pydantic AI, Deep Agents, or
`pi-dynamic-workflows`.

Research handoff separates content from workflow state:

```text
Markdown blob   model-readable analysis
artifact ref    compact content-addressed handle
task receipt    small coverage/gap/error envelope
```

Large prose remains in artifacts and downstream Agents retrieve it on demand.
JSON is used only where the runtime needs validation and control signals.

Pi supplies Agent sessions, model/tool execution, and context compaction. Pi
and provider auto-retry are disabled; the Wiki task runtime is the only owner
of transient retry. It also supplies repository/path authorization,
concurrency admission, one bounded fresh-session retry, durable artifact
acceptance, deterministic validation, and atomic publication.

Transient 500-class failures and timeouts receive at most one fresh-session
retry. 429 reduces shared admission, honors `Retry-After`, and retries once;
exhaustion remains an explicit failed task receipt. Authentication, billing,
invalid requests, and hard quota failures do not retry, and quota failures
durably pause the run. Partial candidate work may remain available to resume,
but it cannot be published without deterministic validation.

See [package documentation](packages/wiki-workflows/README.md) and
[architecture](packages/wiki-workflows/ARCHITECTURE.md).
