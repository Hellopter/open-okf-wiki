# Repository Wiki Producer Method

This is an internal method pack frozen into every run as `workdir/method/`. It is not installed as a
Claude Skill and is not a user entrypoint. The only human command is the native `/wiki` workflow.

**Orchestration:** `wiki.workflow.js`.
**Host tools:** `ow prepare`, `ow handoff write|validate|publish`, `ow checkpoint`, `ow gate`, and
`ow validate` via the pinned `hostCli` in `inputs/run-policy.json`. Handoff proposals are always
host-authored with `version: 2`; agents write data-plane artifacts only.

## Lifecycle and checkpoints

| Workflow stage | Required handoff |
|---|---|
| Bootstrap | `ow prepare` returns a minimal RunContext. |
| Discover | Survey receipts are indexed by a `discover` checkpoint. |
| Plan | The `plan` checkpoint binds the Discovery Map, Spec, and assignments; the host gate then grants write authority. |
| Write | Owner-scoped candidate pages and write receipts are indexed by a `write` checkpoint. |
| Verify/repair | Defects and affected-owner repairs are indexed by `review-*` checkpoints. |
| Validate | `ow validate` creates or reuses a verified candidate manifest; only `checkpoint validate` seals the run. |

The active-run pointer is `.wiki-agent/current.json`. It names a run and its last trusted checkpoint;
it never routes to another workflow or stores workflow arguments.

## Workdir contract

| Path | Role |
|---|---|
| `sources/<id>/` | Filtered, content-hashed frozen evidence. |
| `method/` | Exact copy of this method pack. |
| `inputs/` | Inventory, snapshot manifest, run policy, plan-gate receipt. |
| `analysis/` | Discovery Map, Spec, assignments, handoffs, checkpoints, receipts, defects, validation, manifest. |
| `candidate/` | Spec-bound pages; writable only before seal. |

Never use mutable registered repositories after freeze. Never write in `sources/`, `method/`, or
`inputs/` except host-owned gate receipts.

## Agent method

1. Discover: `references/research.md` -> source-first survey (`always` units; optional on-demand surface promotion) -> `analysis/discovery-map.json` -> checkpoint.
2. Plan: `references/plan.md` -> `analysis/spec.json` + assignments -> plan checkpoint -> host gate.
3. Write: `references/generate.md` -> owner-scoped pages only -> checkpoint.
4. Review: `references/review.md` -> evidence and global lenses -> defects -> owner-scoped repair loop.
5. Validate: host `validate` verifies and manifests the candidate; the validate checkpoint seals only a clean review leaf.

Children return compact `{status,summary,openQuestions,...}` envelopes and data-plane files. Host
`ow handoff publish` writes version-2 proposals and checkpoints. See `references/orchestrator-context.md`.

## Output rules

Prose follows `wikiLanguage` from `inputs/run-policy.json` (`en`|`zh`). For `zh`, Simplified Chinese
only for human-readable text; keep identifiers/paths untranslated. Concept pages need YAML `type`,
`title`, `description`. Do not author `index.md`, `log.md`, or OKF system fields.

Every factual claim needs a local Markdown source link with genuine 1-based lines:

```md
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)
```

No `repo:`, remote URLs, `file://`, `vscode://`, or targets outside frozen `sources/`. Never estimate
line ranges.
