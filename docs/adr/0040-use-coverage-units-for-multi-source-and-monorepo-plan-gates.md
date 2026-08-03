# Use coverage units for multi-source and monorepo plan gates

**Status:** accepted  
**Date:** 2026-08-03  
**Refines:** [ADR 0036](0036-semantic-artifact-plane-and-execution-plan.md) (WikiSpec / ExecutionPlan / plan revise / light path), [ADR 0009](0009-configure-a-repository-snapshot-set.md) (Repository Snapshot Set)  
**Retains:** WikiRuns control plane (0035), single Writer, host mechanical validate, EvaluationRound repair loop (0037/0038), no-compat culture (0029)  
**Does not introduce:** knowledge graph, multi-writer wiki, generic workflow DSL, unbounded re-scout, dual Spec authorities  
**Research basis:** [multi-source-plan-phase-bias-2026-08-03](../research/multi-source-plan-phase-bias-2026-08-03.md), [multi-repo-product-landscape-2026-08-03](../research/multi-repo-product-landscape-2026-08-03.md), [current-wiki-workflow-optimization-2026-07-29](../research/current-wiki-workflow-optimization-2026-07-29.md) (P0-2 plan revise)

## Context

ADR 0009 already allows a Wiki Run to freeze multiple named repositories. ADR 0036 already requires a sealed WikiSpec, host-compiled ExecutionPlan, plan gate binding, and plan revise that loads prior Spec + feedback. The Producer Skill already mounts `sources/<id>/` and requires multi-source citations as `repo:<id>/path`.

What was missing as a *product* plan gate was treating multi-source (and large single-repo multi-package) inventory as **coverage obligations**. Current Plan scouts slice by thematic kind (`entry|layout|tests|risks`) and adaptive routing collapses multi-source into “large,” so the synthesizer can primacy-bias the first mount, omit small sources, and still submit a Spec that compiles. Research (position bias / lost-in-the-middle / PlanRAG re-plan) and product landscape (per-repo survey before narrative join) both require a host-checkable coverage contract—not more thematic scouts alone.

This ADR is the **full product** surface for that contract (not an MVP slice): every freeze unit that must appear in the plan is a CoverageUnit; the host asserts coverage at every Spec seal point; plan revise finally fulfills the prior_spec promise in ADR 0036.

## Decision

### 1. CoverageUnit = source | surface (source-qualified ids)

A **CoverageUnit** is one plan-time obligation the Spec must address or explicitly cancel.

| Kind | Meaning | Id shape (normative intent) |
|------|---------|-----------------------------|
| **source** | One frozen repository in the Snapshot Set | the freeze `sourceId` |
| **surface** | A first-class package / app / deployable / docs root *inside* a source (monorepo or multi-entry tree) | **source-qualified**: `<sourceId>::<path>` (double-colon; not `/`) |

Surfaces never float without a source. Single-repo multi-package trees use one source id plus many surface units. Multi-source runs always have at least one source unit per freeze member; surfaces are additive when inventory detects multi-entry layout.

### 2. Freeze seals CoverageInventory and CoveragePlan (deterministic host)

At freeze (or immediately after deterministic inventory on sealed mounts), the host builds and seals:

| Artifact | Role |
|----------|------|
| **CoverageInventory** | Observed units: every freeze source; optional surfaces from multi-entry / multi-package signals; path samples and boundary path lists only |
| **CoveragePlan** | Which inventory units are **required** for this Run (operator focus may demote non-critical units to optional/cancelled; demotion is explicit and auditable) |

Inventory is host-deterministic (path/manifest heuristics). It is an **accelerator and membership set for coverage gates**, not a citation allowlist—paths under `sources/` remain citable when grounded (existing skill rule).

### 3. Hybrid scouts + bounded plan coverage loop

Plan exploration is **hybrid**:

1. **Coverage-aware scouts** — when required units > 1 (multi-source, or multi-surface monorepo), schedule survey capacity keyed to units (per-source and/or per-surface slots), not only thematic kinds. Thematic lenses remain useful *after* unit surveys, within orchestration caps.
2. **Synthesize** one WikiSpec (single Spec authority retained).
3. **Host `assertCoverage`** against CoveragePlan + Spec bindings.
4. On gap: **re-scout only missing units**, then re-synthesize — at most **R** plan coverage rounds (host budget; fail closed when exhausted rather than soft-forward with silent omissions).

Soft-empty scout receipts must not satisfy a required unit. Multi-source **never** takes the light path (see §8).

### 4. Spec binds `coverageUnitIds` (canonical); `sourceIds` / `surfaceIds` are projections

WikiSpec pages and domains bind coverage via **`coverageUnitIds`** (canonical field family). Host validators may accept or project:

- `sourceIds` — projection of source-kind units  
- `surfaceIds` — projection of surface-kind units (still source-qualified)

Gate logic always normalizes to CoverageUnit ids. A required unit is covered when at least one non-cancelled page or domain binds it, **or** the Spec records an explicit cancellation for that unit (non-critical only when CoveragePlan allows). Critical required units cannot be cancelled by the model alone.

### 5. `prior_spec` on plan revise (fulfill ADR 0036)

Plan gate **revise** (and any host replan that is not a green-field StartRun) must materialize:

- sealed **prior Spec** as Attempt input (`prior_spec` / equivalent role under `inputs/`)
- operator **feedback** (gate detail / `operator_input`)

The planner submits a **complete** new Spec with changelog; it does not invent a blank page tree while ignoring the prior tree. This closes research P0-2 and the ADR 0036 sentence “Plan revise loads prior Spec + feedback.”

### 6. Host `assertCoverage` on every Spec seal path

`assertCoverage(CoveragePlan, Spec)` runs fail-closed on:

| Path | Why |
|------|-----|
| `submit_wiki_run_spec` | Reject incomplete drafts before `analysis/plan-draft.json` is trusted |
| `compileExecutionPlan` | Do not compile a topology that already omits required units |
| Plan **approve** | Operator approval cannot launder an under-covered Spec |
| Mechanical **validate** (pre/final as Spec-aware checks) | Catch drift if Spec artifacts are rebound |
| **`planConfirm=false` auto-approve** | Headless path uses the same onPlanAccepted contract—no coverage bypass |

Failed assertion returns structured missing unit ids; it does not invent pages.

### 7. BoundaryIndex is a path list only — no knowledge graph

Optional **BoundaryIndex** (or inventory section) may list high-signal paths: manifests, entrypoints, OpenAPI/proto/routes, package boundaries. It is a **deterministic path list** sealed with inventory—not a graph database, not claim ledger, not multi-writer knowledge store. Cross-source edges in the Wiki remain narrative + citations; deterministic path hints only reduce primacy and support scout prompts.

### 8. Light path: small single-repo only; multi-source never light

| Situation | Light path (`planScoutCount=0`, single review lens defaults) |
|-----------|----------------------------------------------------------------|
| Single source, small inventory, low uncertainty | Allowed (ADR 0036 default retained) |
| Single source, multi-surface / multi-entry / large | Raise scouts; coverage units include surfaces; not “pretend one README” |
| **`sourceCount >= 2`** | **Never light** — at least unit-aware survey capacity and mandatory `assertCoverage` |

Adaptive routing must not treat multi-source as merely `large` thematic scout count. Operator-explicit orchestration raises still win as upper preference, but cannot disable multi-source coverage assertion.

### 9. Loops live on the execution graph — not a knowledge graph

Two bounded loops only:

```text
Plan coverage loop:
  scout → synthesize Spec → assertCoverage → (gap ? re-scout ≤R : plan gate)

Evaluation / repair loop (existing 0037/0038):
  WikiCandidate → validate → seats → reduce → repair.N → re-eval
```

No separate knowledge-graph build/repair pipeline. Coverage obligations are plan-time and Spec-bound; post-write quality remains EvaluationRound.

## Consequences

- Plan completion is machine-checkable for multi-source and multi-surface monorepos: every required CoverageUnit is bound or explicitly cancelled.
- Skill and planner prompts must instruct repository maps, per-unit survey, and cross-source flows—not first-README-only exploration (see Producer Skill `references/plan.md`).
- Freeze gains sealed coverage artifacts; ExecutionPlan compile and planConfirm=false share one assertion.
- Plan revise becomes true revision (prior_spec + feedback), fulfilling ADR 0036.
- Product still rejects KG / multi-writer / unbounded replan; R and orchestration caps remain host budgets.
- Implementation may land schemas and host checks incrementally, but the **accepted product contract** is full coverage-unit gates—not a permanently weaker MVP.

## Related

- Producer Skill plan method: `packages/skill/references/plan.md`
- Adaptive light-path defaults: `packages/contract/src/adaptive-router.ts` (to be aligned with §8)
- WikiRuns plan gate / auto-approve: workflow plan success + `planConfirm`
