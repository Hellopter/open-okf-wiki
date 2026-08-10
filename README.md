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
active Wiki run. Completed and interrupted run records are also retained per
workspace across Pi sessions.

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
inputs, or run history.

## Workflow

Every run uses five user-visible stages:

```text
Inspect -> Research -> Plan -> Write -> Verify
```

Research uses a fresh agent per source and may run one bounded targeted batch.
Plan produces the complete target page topology. Write starts one fresh agent
per content page with at most four active writers, then starts a fresh Overview
writer after the content-page barrier. In refresh mode only impacted or new
content pages plus Overview are rewritten unless a structural replan requires a
full rewrite.

Verify runs pure static validation and an independent semantic reviewer.
Page-local defects return to fresh page writers; topology or coverage defects
return to one bounded structural replan. Only after review succeeds does a
deterministic finalizer remove obsolete Markdown, rebuild indexes, preserve
non-Markdown assets, and assert that the final page set exactly matches the
Spec. Agents never delete pages.

The packaged producer skill is `repository-wiki-producer`; its role references
keep research, planning, page writing, and review prompts separate.

## Commands

```text
/wiki
/wiki open
/wiki generate [lang=zh|en] [focus]
/wiki refresh [lang=zh|en] [focus]
/wiki status
/wiki history
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

`/wiki` and `/wiki status` return immediately with the current run status;
`/wiki history` returns a concise project history. `/wiki open` explicitly
opens the run console, whose root view selects live and historical runs. It
shows phase and Agent state, compact tool targets and result summaries, token
and context figures, validation failures, and Pi compaction and retry activity.
Enter an Agent detail to reveal its retained raw tool payloads only when needed.

Retrying one settled Agent retains valid upstream results and invalidates its
downstream work. `R` on a settled phase retries its Agents together and is
refused while that phase has a running Agent. Retrying a historical terminal
run creates a new branch run; the selected history remains immutable.
Non-current completed history can be deleted from the console, while the newest
100 terminal runs are otherwise retained.

## Guarantees

- Each declared source Git repository is the only source history and rollback
  mechanism.
- All generated pages live below `wiki/`; each writer is restricted to one
  assigned page and explicitly authorized source and Wiki reads.
- Source references begin with the declared project directory, for example
  `api/src/server.ts#L12-L38`; body citations use
  `repo:api/src/server.ts#L12-L38`.
- Pi session custom entries retain the active-session recovery state. Project
  history is stored under Pi's agent directory as bounded run snapshots (Agent
  outputs, attempt history, and tool summaries), never copied source files or
  Wiki snapshots. Git remains the rollback path.
- Pi's own auto-compaction and provider retry capabilities are enabled for
  subagents; the console reports their activity without reimplementing them.
