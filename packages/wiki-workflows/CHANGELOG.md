# Changelog

All notable changes to `@okf-wiki/wiki-workflows` are documented here.

## [Unreleased]

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

- Added durable run ledgers, workspace-scoped run discovery, pause/resume,
  cancellation, and cross-process single-run ownership.
- Resume preserves the candidate and rejects source fingerprint drift before
  re-entering the Lead, preventing mixed-source publication.
- Disabled Pi and provider automatic retry. `WikiTaskRuntime` is the sole
  transient retry owner and permits at most one fresh session.
- Added shared 429 admission control with `Retry-After`; hard quota and usage
  limits durably pause the run, while authentication, billing, invalid request,
  schema, artifact I/O, and publication I/O failures do not retry.
- Publication continues to use a recoverable rename journal and atomic swap.

### Commands

- Added `/wiki init` with language, repeatable source excludes, and default
  ignore controls for explicit multi-source workspaces.
- Added `/wiki source add link` for local Git roots and `/wiki source add clone`
  for local or remote URLs, with optional source names, workspace paths and refs.
- Existing run commands remain `/wiki [focus]`, `regenerate`, `status`, `runs`,
  `pause`, `resume`, and `cancel`. A Git repository without `workspace.yaml`
  remains an implicit single source and needs no initialization.
