# Open OKF Wiki

Git-native repository Wiki production as a Pi extension. A Wiki workspace is
a plain directory with `workspace.yaml`, one or more linked or cloned Git
projects at its root, and generated documentation only under `wiki/`.

## Install

Requires Node.js `>=22.19.0` and Pi.

```bash
pnpm install
pnpm build
pi install ./packages/wiki-workflows
```

The package has no CLI, saved workflow, installer command, source copy, or
repository snapshot. `pi install` installs the local package into Pi's global
extension set.

## Workspace Setup

The workspace itself does not need to be a Git repository. Initialize it once
with its persistent Wiki language, then add Git projects. A project keeps its
directory name as its identity; there is no separate source ID or alias.

```text
/wiki init --workspace docs --lang zh
/wiki source add link ../api --workspace docs
/wiki source add clone https://github.com/example/web.git --ref main --workspace docs
```

After setup, start Pi with `docs` as its current directory before running
`/wiki generate`, `/wiki refresh`, or `/wiki open`. One Pi session owns one
active Wiki workspace and its recoverable run state.

On Windows, local sources use a directory junction where possible, avoiding
the symlink privilege requirement. UNC paths fall back to a directory symlink
and report an actionable error when Developer Mode or elevation is required.

`workspace.yaml` is the only workspace configuration:

```yaml
version: 1
language: zh
defaultSourceIgnores: true
sources:
  - path: api
    origin:
      type: link
      localPath: /absolute/path/to/api
```

It stores declared source locations, the default language, and whether common
generated directories are ignored. It never stores source snapshots, copied
inputs, or run checkpoints.

## Commands

```text
/wiki
/wiki open
/wiki generate [lang=zh|en] [focus]
/wiki refresh [lang=zh|en] [focus]
/wiki status
/wiki pause
/wiki resume
/wiki cancel
/wiki init [--workspace <directory>] [--lang zh|en]
/wiki source add link <local-repository> [--workspace <directory>]
/wiki source add clone <git-url> [--ref <branch>] [--workspace <directory>]
```

`generate` rebuilds the managed Wiki in the language saved by `/wiki init`.
`lang=zh|en` remains an explicit one-run override. `refresh` uses current
staged, unstaged, and untracked changes from declared Git projects plus page
citations to find an affected subset. Independent source repositories have no
shared generation baseline, so it falls back to a full rebuild whenever that
incremental range cannot be trusted.

`/wiki` and `/wiki status` return immediately with the run status. `/wiki open`
explicitly opens the run console, so a normal command never waits on the
modal. The console shows the idle workspace configuration or the live dynamic
plan/write/review loop, node context, automatic Pi compaction and retry
activity, token/context figures, validation failures, and targeted node retry.
Retrying a node retains valid upstream results and invalidates only that node's
downstream work.

## Guarantees

- Each declared source Git repository is the only source history and rollback
  mechanism.
- All generated pages live below `wiki/`; writer agents are host-restricted to
  that directory.
- Source references begin with the declared project directory, for example
  `api/src/server.ts#L12-L38`; body citations use
  `repo:api/src/server.ts#L12-L38`.
- Pi session custom entries retain workflow state for the current session only.
  They contain execution state, not copied source files or Wiki snapshots.
- Pi's own auto-compaction and provider retry capabilities are enabled for
  subagents; the console reports their activity without reimplementing them.
