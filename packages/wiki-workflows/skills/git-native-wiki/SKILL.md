---
name: git-native-wiki
description: Generate or refresh a source-grounded repository Wiki in a local Git workspace. Use when asked to document a repository, produce its Wiki, or refresh repository documentation from source changes.
---

# Git-native Wiki

The current Git worktree is the only source of truth. Use `/wiki generate` for
an initial Wiki and `/wiki refresh` after source changes. Set `lang=en` only
when English is requested; Chinese is the default.

Do not clone repositories, create source registries, copy source trees,
snapshot inputs, or write run manifests. The extension manages its run state
inside the active Pi session and writes generated pages only under `wiki/`.

Every page requires YAML frontmatter with workspace-relative sources and line
ranges:

```yaml
---
type: component
title: Example component
description: What this page explains.
sources:
  - src/example.ts#L12-L38
---
```

In Markdown body, cite source code as
`[label](repo:src/example.ts#L12-L38)`. Never emit `sources/`, `inputs/`, source
IDs, absolute paths, or temporary run paths. Keep code facts tied to exact
current code and preserve valid Wiki links.

`/wiki` opens the workflow console. It exposes validation errors, agent context
and compaction activity, provider retries, and targeted retry for a settled
node. Retrying preserves valid upstream work and invalidates only downstream
nodes.
