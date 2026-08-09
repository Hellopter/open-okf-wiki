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
parent directory. The extension manages its run state inside the active Pi
session and writes generated pages only under `wiki/`.

Every page requires YAML frontmatter with workspace-relative sources and line
ranges:

```yaml
---
type: component
title: Example component
description: What this page explains.
sources:
  - api/src/example.ts#L12-L38
---
```

In Markdown body, cite source code as
`[label](repo:api/src/example.ts#L12-L38)`. The first path component must be a
declared project directory. Never emit `sources/`, `inputs/`, source IDs,
absolute paths, or temporary run paths. Keep code facts tied to exact current
code and preserve valid Wiki links.

`/wiki` returns status without opening a modal. `/wiki open` opens the workflow
console, which exposes validation errors, agent context and compaction activity,
provider retries, and targeted retry for a settled node. Retrying preserves
valid upstream work and invalidates only downstream nodes.
