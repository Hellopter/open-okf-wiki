---
name: repository-wiki-producer
description: Method pack for source-grounded OKF Wiki production from frozen run workdirs. Progressive agent instructions (research, plan, generate, review). Not a human entry — humans use /wiki.
user-invocable: false
---

# Repository Wiki Producer (method)

This Skill is the **method layer** for agents. It is frozen into each run as `workdir/skill/` and must not be treated as the human slash entry.

**Human entry:** `/wiki` (entry skill).  
**Orchestration:** Claude workflows `/wiki-produce`, `/wiki-plan`, `/wiki-write-review`.  
**Host tools (agent API):** `ow freeze|run|gate|validate|retry|status` via pinned `hostCli` in `inputs/run-policy.json`.

## Lifecycle (host + workflow)

| Host / workflow action | Contract |
|---|---|
| Entry `/wiki` or `ow run` | Freeze sources + this method Skill; write `.wiki-agent/current.json`. |
| `/wiki-plan` or plan stage of produce | Discover + Plan; auto `ow gate plan` unless `approvePlan`. |
| `ow gate plan` / `ow approve plan` | Digest-bound write authority receipt. |
| `/wiki-write-review` or write stage | Preflight `gate check` → write → review → `validate` seal. |
| `ow retry --from plan\|write` | Discard derived artifacts; refresh next-action. |

### Active-run pointers

| Path | Role |
|---|---|
| `.wiki-agent/current.json` | Active `runId`, absolute `workdir`, phase, next workflow command. |
| `.wiki-agent/next-action.json` | Same + reason. |

Workflows accept optional `{runId,workdir}` but **prefer no-arg** resolve: args → current → next-action → newest run.

## Workdir contract

| Path | Role |
|---|---|
| `sources/<id>/` | Filtered, content-hashed frozen evidence. |
| `skill/` | Exact copy of this method Skill. |
| `inputs/` | Inventory, snapshot manifest, run policy, plan-gate receipt. |
| `analysis/` | Discovery Map, Spec, receipts, defects, validation, manifest. |
| `candidate/` | Spec-bound pages; writable only before seal. |

Never use mutable registered repositories after freeze. Never write in `sources/`, `skill/`, or `inputs/` except host-owned gate receipt.

## Agent method

1. Discover: `references/research.md` → survey coverage units → `analysis/discovery-map.json`.
2. Plan: `references/plan.md` → `analysis/spec.json` → host `gate plan` (or stop for approve).
3. Write: `references/generate.md` → Spec pages only under `candidate/`.
4. Review: `references/review.md` → independent lenses → `defects.json` → repair majors/blockers.
5. Validate: host `validate` seals.

Children return compact `{status,path,summary,digest?}` envelopes. File-first handoffs: `references/orchestrator-context.md`.

## Output rules

Prose follows `wikiLanguage` from `inputs/run-policy.json` (`en`|`zh`). For `zh`, Simplified Chinese only for human-readable text; keep identifiers/paths untranslated. Concept pages need YAML `type`, `title`, `description`. Do not author `index.md`, `log.md`, or OKF system fields.

Every factual claim needs a local Markdown source link with genuine 1-based lines:

```md
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)
```

No `repo:`, remote URLs, `file://`, `vscode://`, or targets outside frozen `sources/`. Never estimate line ranges.
