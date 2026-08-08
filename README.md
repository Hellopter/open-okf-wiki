# Open OKF Wiki

Git-native repository Wiki production as a Pi extension. The extension reads
the current Git workspace directly and writes generated documentation only to
`wiki/`.

## Install

Requires Node.js `>=22.19.0` and Pi.

```bash
pnpm install
pnpm build
pi install ./packages/wiki-workflows
```

The package has no CLI, saved workflow, installer command, source registry, or
repository snapshot.

## Commands

```text
/wiki
/wiki generate [lang=zh|en] [focus]
/wiki refresh [lang=zh|en] [focus]
/wiki status
/wiki pause
/wiki resume
/wiki cancel
```

`generate` rebuilds the managed Wiki. `refresh` uses Git history, staged and
unstaged changes, untracked files, and page citations to find an affected
subset. It falls back to a full rebuild when the existing Wiki cannot be a
trusted baseline.

`/wiki` opens the run console. It shows the live dynamic plan/write/review
loop, node context, automatic Pi compaction and retry activity, token/context
figures, validation failures, and targeted node retry. Retrying a node retains
valid upstream results and invalidates only that node's downstream work.

## Guarantees

- Git is the only source history and rollback mechanism.
- All generated pages live below `wiki/`; writer agents are host-restricted to
  that directory.
- Source references are workspace-relative `path#Lx-Ly`; body citations use
  `repo:path#Lx-Ly`.
- Pi session custom entries retain workflow state for the current session only.
  They contain execution state, not copied source files or Wiki snapshots.
- Pi's own auto-compaction and provider retry capabilities are enabled for
  subagents; the console reports their activity without reimplementing them.
