---
name: git-native-wiki
description: Generate or refresh a source-grounded repository Wiki in a local Git workspace. Use when asked to document a repository, produce its Wiki, or refresh repository documentation from source changes.
---

# Git-native Wiki

The current Git worktree is the only source of truth. Run from the repository
root and use the installed `/wiki-generate` or `/wiki-refresh` workflow. Do
not clone repositories, create source registries, copy source trees, snapshot
inputs, or write run manifests.

## Commands

Install the project-scoped saved workflows once:

```sh
okf-wiki install
```

Run `/wiki-generate lang=zh` for an initial Wiki, or
`/wiki-refresh lang=zh` after source changes. Set `lang=en` only when English
is requested. Extra command text is the generation focus.

`/wiki-refresh` first runs `okf-wiki inspect --json`. It uses Git history plus
staged, unstaged, and untracked worktree changes to identify affected pages.
If the existing `wiki/` output has drifted or impact cannot be resolved
reliably, it intentionally performs a full rebuild.

## Output Contract

The workflow alone manages `wiki/`. Do not put hand-authored documents there.
Every page must have YAML frontmatter:

```yaml
---
type: component
title: Example component
description: What this page explains.
sources:
  - src/example.ts#L12-L38
---
```

`sources` entries are always paths relative to the workspace root and must
include a line range. In Markdown body, cite source code as
`[label](repo:src/example.ts#L12-L38)`. Never emit `sources/`, `inputs/`,
source IDs, absolute paths, or paths to temporary run directories. Keep code
facts tied to exact current code and update links and navigation with the page.

## Review Loop

The saved workflow uses one writer and at most four independent read-only
research agents. A reviewer sends evidence, link, and formatting defects to a
local repair. Only topology or coverage defects trigger one revised plan. The
review/repair loop has two rounds; remaining defects fail the run instead of
silently publishing incomplete documentation.

The dedicated finalizer runs `okf-wiki finalize --json`, returning its exit code
and parsed validation JSON; only exit code zero with `ok: true` passes. It does
not repair Wiki files. Each agent call has one automatic retry for recoverable
execution failures. To retry one settled agent, open its Navigator detail and
press `r`; its completed prefix replays and its downstream work reruns.
