---
name: repository-wiki-producer
description: Use when the user asks to build, update, regenerate, or refresh a repository Wiki. Invoke the /wiki command. Do not write wiki/ pages yourself.
---

# Repository Wiki Producer

Invoke `/wiki`. The extension owns planning, writing, review, validation, and
publication. Do not edit `wiki/` or invent production-session tools in this
host session.

## Commands

| Command | Use |
|---|---|
| `/wiki [focus]` | Update the Wiki. Optional focus narrows research without dropping essential context. |
| `/wiki regenerate [focus]` | Discard the prior page topology and rebuild it. |
| `/wiki init [workspace] [--lang zh\|en] [--exclude <glob>]... [--no-default-ignores]` | Create an explicit multi-source workspace. |
| `/wiki source add link <local-git-root>` | Link a local Git repository root (symlink on Linux/macOS, junction on Windows). |
| `/wiki source add clone <url>` | Clone a local or remote Git URL when linking is unsuitable. |
| `/wiki status [run-id] [lead\|batch-N/task-id] [--process]` | Inspect the current or named run. |
| `/wiki runs` | List runs in this workspace. |
| `/wiki pause` / `/wiki resume [run-id]` / `/wiki cancel [run-id]` | Control the active run. |

A Git repository without `workspace.yaml` is an implicit single source. Existing
multi-source workspaces use their declared sources. Use `init` only to create an
explicit workspace, then add sources.

The host owns run state, source fingerprints, path authorization, validation,
and publication. Do not create workflow manifests, source copies, or alternate
plans.
