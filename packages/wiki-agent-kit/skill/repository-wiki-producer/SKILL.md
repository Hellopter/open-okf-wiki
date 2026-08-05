---
name: repository-wiki-producer
description: Produce a source-grounded OKF Wiki candidate from immutable repository snapshots. Use the frozen run workdir, local Markdown source citations, and the deterministic ow gate and validator. Prefer no-arg Claude workflows that resolve .wiki-agent/current.json.
---

# Repository Wiki Producer

Produce a Wiki candidate only from a frozen run workdir. `sources/` and `skill/` are immutable
evidence; `candidate/` is the only Wiki output and remains run-local. There is no publish action.

## Lifecycle

The deterministic host owns freeze, gates, validate, and active-run pointers. Claude workflows own
orchestration and call host CLI actions automatically.

| Command | Contract |
|---|---|
| `ow run [--focus TEXT]` | Freeze sources + Skill, write `.wiki-agent/current.json`, emit `/wiki-produce`. |
| `ow freeze [--focus TEXT]` | Same snapshot as run; default next command is `/wiki-produce` (or `/wiki-plan` with `--approve-plan`). |
| `ow gate plan [--run <id>]` | Verify planning artifacts and write a digest-bound receipt. Auto-run by workflows unless `approvePlan`. |
| `ow gate check [--run <id>]` | Recheck that receipt before candidate mutation or validation. Auto-run inside write workflow. |
| `ow validate [--run <id>]` | Regenerate indexes, validate, and seal. Auto-run inside write workflow. |
| `ow approve plan [--run <id>]` | Human sign-off path only (`--approve-plan` mode). |
| `ow retry [--run <id>] --from plan\|write` | Explicitly discard derived artifacts and refresh next-action. |

### Active-run pointers

| Path | Role |
|---|---|
| `.wiki-agent/current.json` | Active `runId`, absolute `workdir`, phase, next command. |
| `.wiki-agent/next-action.json` | Same identity plus reason; workflows resolve this when args are omitted. |

Claude workflows accept optional `{runId,workdir}` args but **prefer no-arg invocation**. Resolve
order: explicit args → `current.json` → `next-action.json` → newest valid run.

## Claude Code path (default)

```text
ow run --focus "authentication and request flow"
# In a Claude Code session started from the workspace:
/wiki-produce
```

`/wiki-produce` automatically:

1. Resolves the active run from disk
2. Runs Discover + Plan
3. Runs `ow gate plan` (unless `approvePlan`)
4. Runs Write + Review + Repair
5. Runs `ow gate check` + `ow validate` and seals

Split workflows remain available:

| Workflow | Role |
|---|---|
| `/wiki-plan` | Discover/Plan + auto `gate plan` (stops for human if `approvePlan`) |
| `/wiki-write-review` | Preflight gate check → write → review → validate |
| `/wiki-produce` | End-to-end compose of the above |

Do **not** manually paste JSON args or hand-run `gate plan` / `validate` in the default path.
Those host actions are invoked by workflow agents through the pinned `hostCli` in
`inputs/run-policy.json`.

Optional human plan approval:

```text
ow run --focus "..." --approve-plan
/wiki-plan
ow approve plan
/wiki-write-review
```

Other Skill hosts follow the same on-disk contracts but do not execute Claude workflow JavaScript.

## Workdir Contract

| Path | Role |
|---|---|
| `sources/<id>/` | Filtered, content-hashed frozen evidence. |
| `skill/` | Exact copied Skill; read its phase reference before work. |
| `inputs/` | Inventory, snapshot manifest, run policy, and plan-gate receipt. |
| `analysis/` | Discovery Map, Spec, receipts, defects, validation output, and candidate manifest. |
| `candidate/` | Spec-bound concept pages, writable only before sealing. |

Never use mutable registered repositories as evidence after freeze. Never write in `sources/`,
`skill/`, or `inputs/`, except that the host owns the plan-gate receipt and workspace pointers.

## Agent Method

1. Discover: read `references/research.md`, survey every required inventory coverage unit from
   frozen sources, preserve failures, and write `analysis/discovery-map.json`.
2. Plan: read `references/plan.md`, write `analysis/spec.json`, bind every required coverage unit or
   cancel it with a structured non-empty reason, then run host `gate plan` (or stop for approve).
3. Write: read `references/generate.md`, treat the Spec pages as the sole page-set authority, and
   write only those concept pages under `candidate/`.
4. Review: read `references/review.md`, keep independent findings in `analysis/receipts/review/`,
   consolidate `analysis/defects.json`, and repair blocking or major defects before validation.
5. Validate: host `validate` regenerates indexes, checks citations, and seals.

Children write full data to disk and return compact `{status, path, summary, digest?}` envelopes.
Maintain a ledger for all coverage units, including failed work. One writer owns `candidate/**`;
surveys and review lenses may run concurrently. Read `references/orchestrator-context.md` for the
file-first handoff rules.

## Output Rules

Write all human-readable prose (titles, descriptions, headings, body text, Spec questions, Discovery
Map labels) in the `wikiLanguage` from `inputs/run-policy.json` (`en` or `zh`). When
`wikiLanguage=zh`, use Simplified Chinese for prose; never leave the candidate mostly in English.
Keep identifiers, source paths, package/module names, APIs, and code tokens untranslated. Concept
pages require non-empty YAML `type`, `title`, and `description`; optional `tags` are allowed. Do not
author `index.md`, `log.md`, `generated`, `verified`, `stale_after`, or `okf_version`.

Every factual claim needs a direct local Markdown link to the frozen source and genuine one-based
line numbers. Calculate the link relative to the candidate page:

```md
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)
[Source: src/A.java L10-L20](../../sources/app/src/A.java#L10-L20)
```

Do not use `repo:`, remote URLs, `file://`, `vscode://`, or targets outside frozen `sources/`.
Never estimate line ranges. A successful `ow validate` writes a hash manifest and makes the
candidate immutable; use `ow retry --from write` before creating a replacement.
