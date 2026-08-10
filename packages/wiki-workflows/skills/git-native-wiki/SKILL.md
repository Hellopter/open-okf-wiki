---
name: git-native-wiki
description: Generate or refresh a source-grounded Wiki from Git projects declared in a local Pi workspace. Use when asked to document a repository, produce its Wiki, or refresh repository documentation from source changes.
---

# Git-native Wiki

Each source project declared by `workspace.yaml` is the only source of truth.
Use `/wiki generate` for an initial Wiki and `/wiki refresh` after source
changes. The workspace language is selected once by `/wiki init --lang zh|en`;
use `lang=en` only for a one-run override.

Do not clone repositories, create source registries, copy source trees,
snapshot inputs, or write run manifests. Source onboarding is performed by the
user through `/wiki source add link` or `/wiki source add clone`. Add
`--workspace <directory>` when the Pi session was started from the workspace's
parent directory. The extension manages the active run in Pi and keeps bounded,
project-scoped execution history under Pi's agent directory; it writes generated
pages only under `wiki/`. History is Agent output and execution metadata, never
copied source trees or Wiki snapshots.

Every page requires YAML frontmatter with workspace-relative sources and line
ranges:

```yaml
---
type: component
title: Example component
description: What this page explains.
tags:
  - architecture
sources:
  - api/src/example.ts#L12-L38
---
```

In Markdown body, cite source code as
`[label](repo:api/src/example.ts#L12-L38)`. The first path component must be a
declared project directory. Never emit `sources/`, `inputs/`, source IDs,
absolute paths, or temporary run paths. Keep code facts tied to exact current
code and preserve valid Wiki links.

`/wiki` returns status without opening a modal and `/wiki history` prints a
concise project history. `/wiki open` opens the workflow console, which selects
live or historical runs and exposes validation errors, Agent context and
compaction activity, provider retries, and targeted retry for a settled node.
Phase retry is refused while that phase has a running Agent. Retrying preserved
history forks a new run; current-run retries preserve valid upstream work and
invalidate only downstream nodes.

For phase-specific operating guidance, read the relevant reference:

- [Planning](references/plan.md)
- [Research receipts](references/research.md)
- [Research synthesis](references/synthesis.md)
- [Writing and repair](references/write.md)
- [Review](references/review.md)

Writers receive page skeletons only when their finalized DomainPacket selects a
page type. The available skeletons are [Overview](references/templates/overview.md),
[Architecture](references/templates/architecture.md), [Module](references/templates/module.md),
[Flow](references/templates/flow.md), and [Concept](references/templates/concept.md).
They are structural guidance, never pages to copy verbatim or fill with
unsupported placeholders.
