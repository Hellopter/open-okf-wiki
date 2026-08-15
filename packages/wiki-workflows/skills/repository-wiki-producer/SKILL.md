---
name: repository-wiki-producer
description: Use when the user asks to build or replace a repository Wiki. Invoke the /wiki command and let the extension own production.
---

# Repository Wiki Producer

Invoke the matching `/wiki` command. The extension owns planning, writing, review, validation, publication, and recovery; the host session leaves `wiki/` unchanged.

## Produce

1. Invoke `/wiki [focus]`. Include `focus` only when the user named a priority; it does not narrow required coverage.
2. Report the created Run id. Production is underway when the command returns a running view.
3. Use `/wiki status` for a current snapshot or `/wiki status <run-id> <lead|batch-N/task-id> [--process]` for one Agent. Inspection is complete when the requested durable view is shown.

Every invocation performs a full generation in a fresh empty Candidate. The Published Wiki and its WikiSpec are provenance, not input.

## Configure Sources

Use `/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]` only to create an explicit multi-source Workspace. Then add each Source with `/wiki source add link <local-git-root>` or `/wiki source add clone <url>`.

A Git repository without `workspace.yaml` is already an implicit single-source Workspace. Source configuration is complete when the command reports the resolved Workspace and Source path.

## Control

Use `/wiki runs` to find Run ids. Use `/wiki pause`, `/wiki resume [run-id]`, or `/wiki cancel [run-id]` for lifecycle control. A control action is complete when the returned view shows the requested state.

Resume preserves pinned settings, Candidate, artifacts, and Pi sessions. Source drift fails closed. Version-1 Run state requires human cleanup; preserve needed evidence before removing stale `.okf-wiki` Run data.
