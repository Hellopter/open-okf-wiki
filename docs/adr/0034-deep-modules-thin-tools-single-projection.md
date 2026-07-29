# Deep modules, thin tools, single projection, real ports

**Status:** accepted  
**Date:** 2026-07-28  
**Refines:** [ADR 0033](0033-run-graph-and-agent-layering.md) (ports DIP / layering), [ADR 0032](0032-pi-tool-owned-wiki-runs.md) (Pi tools own runs), [ADR 0031](0031-unidirectional-framework-first-operator-surface.md) (pure projection)  
**Related:** ADR 0029 (no-compat), codebase-design skill (deep modules / seam vocabulary)  
**Does not supersede:** Pi Session authority (0032), Run Boundary in `@okf-wiki/core` (0019), Run Graph as observation only (0033)  
**Index:** [docs/adr/README.md](README.md)

## Context

After ADR 0033, the tree still accumulated **shallow surfaces** that fought locality and testability:

- `@okf-wiki/contract` mega-barrel re-exported internal helpers, deprecated schemas, and unused phase-transition helpers.
- Web kept zero-depth shims (`pi-message`) and hand-rolled snapshot projection beside contract `applyStreamPatch`.
- `wiki_repair` was a fat Pi tool (admission, locks, layout bootstrap, workflow) while `wiki_produce` stayed thin.
- `useSessionAgent` mirrored `status` / `error` in React state beside `streamStateRef`, with `clearError` bypassing the projector.
- `ProgressSink` existed as a port but phases mostly called raw `onProgress` / `emitProgress` — a half-used seam.
- Core duplicated `LIST_LINK_RE` parsers; `citations.ts` mixed parse, canonicalize, resolve, and staging rewrite.
- Run Graph view-model computed `edges` the canvas never drew.

We needed explicit product rules aligned with 2025–2026 TypeScript / agent / React practice: **narrow package surfaces**, **thin tool adapters**, **bounded repair in workflow**, **single projection true-source**, **ports only when real**.

## Decision

### 1. Package public surface is intentional

- Contract (and core) barrels export **stable cross-package types and functions only**.
- Do not re-export: internal field schemas, deprecated transitional schemas, dead helpers, or test-only symbols.
- Prefer deleting zero-depth shims over “export regression” tests that only lock the shim.
- Optional future: `package.json` `"exports"` subpaths; until then, **unexport is the API**.

### 2. Deep modules; real seams only

Vocabulary matches the codebase-design skill:

| Rule | Product application |
|------|---------------------|
| Deep module | Small interface, large behavior (e.g. stream reduce in contract, repair loop in workflow) |
| One adapter ≈ false seam | Do not invent ports for documentation; delete unused port types (`WikiWriter`) |
| Two adapters ≈ real seam | Keep `AgentRunner` (live + fixture), `GraphStore` (core + memory tests), `GatePort`, etc. |
| Progress protocol | **One** fan-out: `ProgressSink`. Tool-edge / attempt callbacks adapt **once** at composition (WikiRuns attempt work / `produceWiki` library). Phases call `progress.emit` only. |

Core-backed stores (`SpecStore`, `ReceiptStore`, `GraphStore`) stay ports: disk I/O + injection for tests. They are not collapsed “because only one production adapter.”

### 3. Pi tools are thin adapters

```
tools/*  →  WikiRuns command dispatch (StartRun / RerunNode)  →  receipt
```

- `wiki_produce` / `wiki_repair`: schema + dispatch durable WikiRuns commands; return a receipt (ADR 0035). They do **not** own the whole Run or await gates.
- Attempt-local phase helpers live under `agent/workflow` / `runtime` for the Pi attempt executor; they are not a second Run owner.
- Layout helpers remain pure path projection (`runtime/workdir.ts`).

### 4. Bounded repair: shared loop, separate strategies, separate budgets

- `runBoundedRepairLoop`: score-first dispatch + a **named** budget counter (`budgetKey`).
- **Invariant:** if abort should not consume budget, `score` must abort **before** returning `{ kind: "repair" }` (documented on the loop; covered by unit tests).
- Council vs hard-validate strategies stay separate call sites — not one god `RepairPolicy`.
- **Independent repair budgets** (do not share one counter):
  - council: `acceptance.maxRepairRounds` → `metrics.repairRounds`
  - mechanical hard-validate: `acceptance.maxHardValidateRepairRounds` → `metrics.hardValidateRepairRounds`
- Phase order: pre-council HV (cheap, no review receipt) → council → post-council HV (fail-closed, review receipt required).
- Other attempt knobs stay **orthogonal**:
  - reviewer seat attempts (`REVIEWER_MAX_ATTEMPTS`)
  - research attempts (`RESEARCH_MAX_ATTEMPTS` in research phase)
  - node transport/retry (`retry-policy` / `DEFAULT_MAX_ATTEMPTS`)

Do not merge these into a single “maxAttempts” policy object.

### 5. Web is pure projection + explicit optimistic bits

- Server owns Pi → stream reduce; web applies **snapshot** and **stream patches** via contract (`applySnapshotWithActiveTool`, `applyStreamPatch`).
- Hook true sources:
  - `PiStreamState` (projector + small local reducers such as clear-error)
  - hook-only `sending` ref for optimistic send (not part of contract stream state)
- Render **derives** `status` / `error` (`deriveAgentStatus`: error → streaming → sending → idle).
- `clearError` goes through the same publish path as stream updates (no ref-only bypass).
- Do not re-export server-only helpers (`reducePiEvent`) from web for “convenience.”

### 6. Core locality

- **One** wiki index listing parser authority (`parseWikiIndexListing` / `LIST_LINK_RE` in wiki-nav). Validate/regenerate project from it; no duplicate regex.
- Citations: parse vs canonicalize(/resolve) as separate modules; publish rewrite stays `citation-rewrite` adapter. Public barrel names may re-export for compatibility.
- Observation view-models must not compute dead outputs the UI never consumes (e.g. Run Graph `edges`).

### 7. No-compat

Per ADR 0029: delete shims and dual paths; update call sites and tests. Do not leave “deprecated barrel forever.”

## Consequences

- Contract surface shrinks; web snapshot logic lives next to stream patches.
- `wiki_repair` mirrors `wiki_produce` thickness; admission is unit-testable without Pi tool context.
- Operator session hook tests can target pure derive/reducers; fewer dual mocks.
- Progress injection tests exercise the real phase path.
- ADR 0033 port table: **`WikiWriter` removed** (was a zero-adapter type alias). Remaining ports stand.

## Out of scope (explicit)

- `live-session-registry` factory / god-struct split (high-risk server concurrency; separate epic).
- Full extraction of council/HV into formal `RepairPolicy` types (optional follow-up; loop + constants landed first).
- Contract `exports` subpath split (optional).
