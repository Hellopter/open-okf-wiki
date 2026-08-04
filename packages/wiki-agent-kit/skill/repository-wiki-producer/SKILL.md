---
name: repository-wiki-producer
description: Produce a source-grounded OKF Wiki from frozen repository snapshots using ow + Claude Dynamic Workflow.
---

# Repository Wiki Producer

Produce or refresh a **source-grounded Wiki** from a pinned freeze workdir. Method lives here;
topology lives in `wiki-produce.workflow.js`; host truth gates live in the **`ow` CLI**.

## When to use `ow`

| Command | When |
|---------|------|
| `ow init` | Create a workspace (`workspace.json`), install skill + workflows |
| `ow source add clone\|path` | Register repositories to document |
| `ow ignore …` | Tune Effective Source Ignores before freeze |
| `ow produce` | Freeze sources + skill into a run workdir; print `runId` / `workdir` |
| `ow gate plan --run <id>` | **Required after Plan** — coverage + semantic sufficiency fail-closed |
| `ow validate --run <id>` | Mechanical OKF frontmatter + citation resolve after write |
| `ow retry --run <id> --from <phase>` | Re-open a failed phase on the same run metadata |
| `ow continue --run <id>` | Resume plan after operator feedback |

Do **not** invent slash commands. Run `ow help` for the full surface.

## Run workdir layout

Agent cwd for produce is the **freeze workdir** (`args.workdir` from the workflow):

| Path | Role |
|------|------|
| `sources/<id>/` | Frozen repository snapshots (read-only) |
| `skill/` | This skill (read-only) — start with `skill/SKILL.md` |
| `inputs/` | Sealed inputs: inventory, discovery-map shell, run-policy |
| `wiki/` | Staging Wiki (writable during write) |
| `analysis/` | This attempt's outputs (spec, receipts, defects) |

## Semantic loop

Read each phase reference **in full** before that phase's work. Do not invent extra method layers.

| Phase | When | Reference |
|-------|------|-----------|
| **Research / Discover** | Survey coverage units; fill discovery map | `skill/references/research.md` |
| **Plan** | Shape Spec / page set before write | `skill/references/plan.md` |
| **Generate** | Write Spec-bound pages into empty `wiki/` | `skill/references/generate.md` |
| **Review** | After write (and each repair round) | `skill/references/review.md` |
| **Orchestrator context** | Always for fan-out / handoffs | `skill/references/orchestrator-context.md` |

### Phase order

1. **Discover.** Read `skill/references/research.md`. Survey every freeze source and required
   coverage unit from `inputs/inventory.json`. Write receipts under `analysis/receipts/`. Merge
   into `analysis/discovery-map.json` (and update `inputs/discovery-map.json` when sealing).
2. **Plan.** Read `skill/references/plan.md`. Write **`analysis/spec.json`** with domains, pages,
   coverage bindings, and cancellations. **Gate:** operator/host must run
   `ow gate plan --run <runId>` before any write. Fail-closed if critical units are unbound.
3. **Write (Spec-bound).** Read `skill/references/generate.md`. Sealed Spec is the **only** page-set
   authority. Adapt templates under `skill/templates/` and write concept pages under `wiki/`.
   Do not author `index.md` / `log.md` as concept work — host regenerates indexes.
4. **Review.** Read `skill/references/review.md`. Repair blocking defects; re-validate with
   `ow validate --run <runId>`. Fail the run if critical pages or citations remain broken.

## Core output contract

### Concept pages (OKF v0.2)

Every concept page (all `.md` except reserved names) begins with YAML frontmatter containing
non-empty **`type`**, **`title`**, and one-sentence **`description`**. Optional `tags` (short
lowercase strings) help navigation. Suggested `type` values: `Overview`, `Architecture`, `Module`,
`Flow`, `Concept`.

```yaml
---
type: Module
title: Session runtime
description: How operator sessions are created, resumed, and streamed.
tags: [session, runtime]
---
```

**Do not author** `generated`, `verified`, `stale_after`, or `okf_version` — the host stamps
provenance at publication. Model-authored timestamps or verification claims are fabrications.

### wikiLanguage

`workspace.wikiLanguage` is `en` or `zh` (see `inputs/run-policy.json`). Write **prose only** in that
language. Do **not** translate repository paths, identifiers, code identifiers, or Source Citation
targets.

### Source Citations

- Single source: `[Source](repo:path/to/file.py#L10-L20)`
- Multi-source: `[Source](repo:repository-id/path/to/file.py#L10-L20)`
- Paths are repository-relative POSIX; line ranges are one-based inclusive.
- Line numbers must come from tool reads — **never invent or estimate** ranges.
- Transform `sources/<id>/rest` → `repo:rest` or `repo:<id>/rest`. **Never** leave a `sources/`
  prefix inside `repo:`.

### Reserved files (OKF)

| File | Role |
|------|------|
| `index.md` (every directory) | Mechanical progressive-disclosure listing. Host regenerates. Not concept work. |
| `log.md` | Optional change history (newest first). |

Narrative entry is **`overview.md`** (or the Spec path) — **not** `index.md`. Spec pages must
**not** list `index.md` or `log.md`.

### Orchestrator discipline

Children return **short JSON envelopes** `{status, path, summary}` only. Full findings live on disk
under `analysis/receipts/`. Never dump transcripts into the parent prompt. See
`skill/references/orchestrator-context.md`.

### Coverage (fail-closed)

Inventory / DiscoveryMap define **coverage units** (sources, surfaces, domains, flows). Every
**required** unit must be bound on Spec pages/domains (`coverageUnitIds`) or explicitly cancelled
(`sourceCoverage` / `surfaceCoverage` with `cancelled: true` + `notes`). Missing critical units
→ plan gate fails; do not write a partial Spec-bound Wiki as if complete.
