# Changelog

All notable changes to `@okf-wiki/wiki-workflows` are documented here.

## [Unreleased]

### Skills

- Split the host `/wiki` skill from the production Lead skill. Each run copies
  the production skill into `.okf-wiki/runs/<id>/skill/`, injects the assigned
  role brief, and allows read-only access to templates.

### Breaking architecture change

- Replaced the fixed DAG, phases, barriers, staged submission tools, node/phase
  retry, snapshot protocol, and TUI with one `WikiProducer` interface and plain
  CLI progress events. Previous run state is intentionally incompatible.
- Added a dynamic Pi Lead loop. The Lead can complete small repositories
  directly or use the single `wiki_delegate` tool for bounded research, write,
  and review tasks.
- Moved long research and review prose to content-addressed Markdown artifacts.
  Durable JSON contains only compact receipts, events, and run state.
- Made the candidate Wiki the only content truth. Page topology is derived from
  candidate Markdown for deterministic frontmatter, evidence, link, Mermaid,
  path, and symlink validation before atomic publication.

### Reliability

- Added `wiki.sessionTimeoutSeconds` so each Lead and delegated Agent session's
  wall-clock deadline is configurable; the default remains 1200 seconds.
- Added durable run ledgers, workspace-scoped run discovery, pause/resume,
  cancellation, and cross-process single-run ownership.
- Resume preserves the candidate and rejects source fingerprint drift before
  re-entering the Lead, preventing mixed-source publication.
- Disabled Pi and provider automatic retry. `WikiTaskRuntime` is the sole
  transient retry owner and permits at most one fresh session.
- Added shared 429 admission control with `Retry-After`; hard quota and usage
  limits durably pause the run, while authentication, billing, local
  schema/validation, artifact I/O, and publication I/O failures do not retry.
  Provider HTTP 400 is retried as a transient Agent failure.
- Research briefs no longer inherit the Wiki reader language. Only writer and
  reviewer prompts require Simplified Chinese or English.
- Publication continues to use a recoverable rename journal and atomic swap.

### Observability

- Added a `/wiki status` progress card, `inspect()` for task receipts and
  handoffs, `--process` compact history, TUI footer/widget, and a bordered
  status overlay that shows context stats for the selected task.

### Commands

- Added `/wiki init` with language, repeatable source excludes, and default
  ignore controls for explicit multi-source workspaces.
- Added `/wiki source add link` for local Git roots and `/wiki source add clone`
  for local or remote URLs, with optional source names, workspace paths and refs.
- Existing run commands remain `/wiki [focus]`, `regenerate`,
  `status [run-id] [task-id] [--process]`, `runs`, `pause`, `resume`, and
  `cancel`. A Git repository without `workspace.yaml` remains an implicit
  single source and needs no initialization.
