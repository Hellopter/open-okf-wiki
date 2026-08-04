---
name: repository-wiki-producer
description: Produce a source-grounded OKF Wiki candidate from immutable repository snapshots. Use the frozen run workdir, local Markdown source citations, and the deterministic ow gate and validator.
---

# Repository Wiki Producer

Produce a Wiki candidate only from a frozen run workdir. `sources/` and `skill/` are immutable
evidence; `candidate/` is the only Wiki output and remains run-local. There is no publish action.

## Lifecycle

The deterministic host commands are intentionally small:

| Command | Contract |
|---|---|
| `ow freeze` | Snapshot sources and this Skill; returns the `/wiki-plan` arguments. |
| `ow gate plan --run <id>` | Verify planning artifacts and write a digest-bound receipt. |
| `ow gate check --run <id>` | Recheck that receipt before candidate mutation or validation. |
| `ow validate --run <id>` | Regenerate indexes, validate, and seal an unsealed candidate. |
| `ow retry --run <id> --from plan|write` | Explicitly discard derived artifacts for a replacement attempt. |

Claude Code runs `/wiki-plan` after `ow freeze`, then the operator runs `ow gate plan`, then Claude
Code runs `/wiki-write-review`. Other hosts follow the same on-disk contracts but do not execute
Claude workflow JavaScript. Workflow agents use the pinned `hostCli` command in
`inputs/run-policy.json`; do not substitute a global `ow` executable.

## Workdir Contract

| Path | Role |
|---|---|
| `sources/<id>/` | Filtered, content-hashed frozen evidence. |
| `skill/` | Exact copied Skill; read its phase reference before work. |
| `inputs/` | Inventory, snapshot manifest, run policy, and plan-gate receipt. |
| `analysis/` | Discovery Map, Spec, receipts, defects, validation output, and candidate manifest. |
| `candidate/` | Spec-bound concept pages, writable only before sealing. |

Never use mutable registered repositories as evidence after `ow freeze`. Never write in `sources/`,
`skill/`, or `inputs/`, except that the host owns the plan-gate receipt.

## Agent Method

1. Discover: read `references/research.md`, survey every required inventory coverage unit from
   frozen sources, preserve failures, and write `analysis/discovery-map.json`.
2. Plan: read `references/plan.md`, write `analysis/spec.json`, bind every required coverage unit or
   cancel it with a structured non-empty reason, then stop for the host gate.
3. Write: read `references/generate.md`, treat the Spec pages as the sole page-set authority, and
   write only those concept pages under `candidate/`.
4. Review: read `references/review.md`, keep independent findings in `analysis/receipts/review/`,
   consolidate `analysis/defects.json`, and repair blocking or major defects before validation.

Children write full data to disk and return compact `{status, path, summary, digest?}` envelopes.
Maintain a ledger for all coverage units, including failed work. One writer owns `candidate/**`;
surveys and review lenses may run concurrently. Read `references/orchestrator-context.md` for the
file-first handoff rules.

## Output Rules

Write prose in the `wikiLanguage` in `inputs/run-policy.json`; keep identifiers and source paths
unchanged. Concept pages require non-empty YAML `type`, `title`, and `description`; optional `tags`
are allowed. Do not author `index.md`, `log.md`, `generated`, `verified`, `stale_after`, or
`okf_version`.

Every factual claim needs a direct local Markdown link to the frozen source and genuine one-based
line numbers. Calculate the link relative to the candidate page:

```md
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)
[Source: src/A.java L10-L20](../../sources/app/src/A.java#L10-L20)
```

Do not use `repo:`, remote URLs, `file://`, `vscode://`, or targets outside frozen `sources/`.
Never estimate line ranges. A successful `ow validate` writes a hash manifest and makes the
candidate immutable; use `ow retry --from write` before creating a replacement.
