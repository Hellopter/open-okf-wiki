# Contract subpaths, agent port thinning, and hard-cut culture

**Status:** accepted  
**Date:** 2026-08-03  
**Refines:** [ADR 0034](0034-deep-modules-thin-tools-single-projection.md) (deep modules / thin tools / single projection), [ADR 0033](0033-run-graph-and-agent-layering.md) (ports DIP / agent layering), [ADR 0039](0039-browser-operator-session-and-run-observation.md) (browser Session / Run split)  
**Related:** [ADR 0035](0035-durable-wikiruns-control-plane.md) (WikiRuns control), [ADR 0029](0029-architecture-cleanup-no-compat.md) (no-compat), [architecture hard-cut checklist](../design/architecture-hard-cut-2026-08.md)  
**Does not supersede:** WikiRuns as sole durable Run control (0035), Pi Session authority for conversation (0032/0039), Run Boundary in `@okf-wiki/core` (0019), CoverageUnit plan gates (0040)  
**Index:** [docs/adr/README.md](README.md)

## Context

By mid hard-cut (Epics A–F), the monorepo had already deleted museum Run-Graph ports and ProgressSink, but several **shallow dual paths** still fought locality:

- `@okf-wiki/contract` re-exported business types from the package root while subpaths existed in intent only.
- Web still risked treating `AgentMessage` / `applyStreamPatch` / `stream-server` as a browser projection path, beside the redacted Session DTO.
- Agent kept a `SpecStore` port for plan-draft I/O even though only one real multi-adapter seam remained (`AgentRunner`: live + fixture).
- Review admission accepted free-text JSON as a fallback beside path-first `analysis/defect-report.json`.
- Agent still carried a `produce/` layer name after whole-Run ownership moved to WikiRuns.
- Workflow control modules still spoke through a zoo of `*Host` factory shapes rather than one control context.

The hard-cut checklist ([architecture-hard-cut-2026-08](../design/architecture-hard-cut-2026-08.md)) locked serial epics A→G. This ADR records the **accepted product decisions** that those epics implement, so live maps and older ADRs stop teaching deleted seams.

## Decision

### 1. Contract exports are a hard-cut subpath API

- Business types and pure helpers live only on intentional **`package.json` `exports` subpaths**.
- Package root `@okf-wiki/contract` exports **errors / package metadata only** (no business schemas, no stream reduce, no WikiRuns types).
- Canonical subpaths (product reality):

  | Subpath | Audience |
  |---------|----------|
  | `/session` | web, server — Session SSE DTO + `applySessionStreamPatch` |
  | `/wiki-runs` | web, server, workflow, agent — commands, snapshot, Spec, evaluation, **observe helpers** |
  | `/coverage` | agent, workflow, core, server — CoverageUnit / `assertCoverage` |
  | `/stream-server` | **server only** (+ contract tests) — `reducePiEvent`, `AgentMessage`, Pi stream reduce |
  | `/workspace` | server, core, web settings |
  | `/pi-attempt` | agent, workflow |

- Consumers switch imports in the same change that enables the architecture ban. No dual barrel period.
- Guard: `banContractRootBusinessImport` in `scripts/check-architecture.mjs`.

### 2. No SpecStore port — plan draft is a deep module

- **Delete** `SpecStore`, `createCoreSpecStore`, and `defaultSpecStore` as product ports.
- Plan candidate I/O is the deep module **`commitPlanDraft(runWorkDir, spec, { coveragePlan?, caps? })`** (plus read/clear helpers as needed): assertCoverage / fan-out caps / Zod → atomic write `analysis/plan-draft.json` → path + receipt fields.
- Tools stay thin: TypeBox schema + call `commitPlanDraft`. Composition may inject the function for tests — that is an **internal seam**, not a reintroduced port type.
- **Keep** `AgentRunner` (live + fixture = real two-adapter seam). It is the only required agent port under `packages/agent/src/ports/`.
- Guard: `banDefaultSpecStore`.

### 3. Path-first review only

- Defect admission is **only** `submit_defect_report` → validated `DefectReportSchema` → atomic `analysis/defect-report.json`.
- **Delete** free-text chat JSON fallback (`tryParseDefectReportJson` and equivalent assembly).
- Skill / prompts state the path rule; assistant prose is never a success handoff.
- Guard: `banFreeTextDefectParse`.

### 4. Test and doc hard-cut (same delivery as source)

- Source, tests, and live docs land **together** per epic. Do not leave characterization tests that lock deleted APIs.
- If more than about one third of a test file fails only because of rename / deleted dual path, **rewrite the whole file**.
- Live maps (L0) always teach current imports and ports. Historical ADR / research get **status notes**, not silent dual truth.
- Forbidden vocabulary in live docs includes: `SpecStore` as a live port, `packages/agent/src/produce/` as a live layer, web `applyStreamPatch` / `AgentMessage` as the browser Session path, Host zoo as the public control seam after WikiRunsControl.

### 5. Session browser projection is the web true-source for conversation

- Browser Session SSE is the redacted DTO under `@okf-wiki/contract/session` (`applySessionStreamPatch`, snapshot + patches).
- Live chat UI is **`SessionTranscript`** driven by that Session stream. **Not** AgentMessage / `AssistantTurn` / `@okf-wiki/contract/stream-server`.
- Server alone reduces raw Pi events (`reducePiEvent` / `AgentMessage` on `/stream-server`) into the Session projection.
- Workbench panel and ids are **URL selection only** (`session`, `run`, `stage`, `attempt`, optional `node`) — no independent React `surface` store as authority (ADR 0039 / Epic F).
- Run observation remains WikiRuns snapshot + Run SSE / Attempt transcript SSE; Session events never synthesize Run state.
- Guard: `banWebStreamServer`.

### 6. WikiRunsControl direction (workflow control locality)

- Durable control modules share one **`WikiRunsControl`** context (DbCtx ⊂ TxCtx ⊂ CasCtx ⊂ Control) built by the WikiRuns owner — not a public zoo of `SchedulerHost` / `CommandsHost` / `EffectsHost` product types.
- Modules accept `WikiRunsControl` or a narrow `Pick` when they need only db/CAS/rerun.
- **Landed:** `WikiRunsControl` in `packages/workflow/src/wiki-runs/ctx.ts`; owner open → build one control → schedule / command / freeze / mechanical paths share it.
- **Landed deep modules:** `attempt-inputs` (sealed input binding), `attempt-finish` (success + fail control effects; no separate `attempt-success` product module), `publication-effect` (ADR 0035 Effect SM). External WikiRuns commands, gates, and Run SSE remain the stable public surface.

### 7. Agent package layout after thinning

```
agent/src/
  ports/       # AgentRunner only
  plan/        # commitPlanDraft deep module
  review/      # commitDefectReport deep module
  workflow/    # Attempt-local phases (plan, …); no whole-Run shell
  runtime/     # Pi adapters, mount, projectors, handlers
  tools/       # Thin: schema + dispatch/commit
  session/     # Operator Session open/project
  prompts/     # role prompts
  redact/      # operator-safe redaction
```

- **No** `produce/` directory. Domain helpers live under `runtime/` / phase modules.
- `wiki_produce` / `wiki_repair` remain thin WikiRuns command dispatch + receipt (ADR 0035).

## Consequences

- Import graphs are audience-shaped: web cannot compile against server-only stream reduce; product code cannot import bare contract root for business types.
- Plan and review handoffs are path-first file receipts; tools cannot grow a second admission channel without failing architecture guards.
- Agent ports collapse to the real seam (`AgentRunner`); plan-draft tests target `commitPlanDraft`, not a store port.
- Operator Session UI and Run Workspace stay visibly linked by receipts and URL selection, with separate connection indicators and separate true-sources.
- Workflow authors extend `WikiRunsControl` rather than inventing new Host types; do not reintroduce a product Host zoo or a second control plane.
- ADRs 0033/0034 status notes must not re-list `SpecStore` or `produce/` as current.

## Non-goals

- Do not resurrect ProgressSink, GatePort, GraphStore, ReceiptStore, RunGraphSnapshot, or `run-wiki` shell.
- Do not put Pi SDK into `workflow/`.
- Do not merge Session SSE and Run SSE.
- Do not thicken `wiki_produce` / `wiki_repair` into whole-Run ownership or gate awaits.
- Do not introduce per-table StoragePort, generic workflow DSL, multi-writer wiki, or knowledge graph.
- Do not rename Publication Effect product states (`prepared → candidate_ready → applying → applied`).
- Do not reintroduce `attempt-success` / `effects` dual hubs or a product `*Host` zoo beside `WikiRunsControl`.
- Do not reintroduce free-text defect JSON or SpecStore “for tests only” as a public port.

## Implementation map (Epics A–G)

| Epic | Scope | Status at acceptance of this ADR |
|------|--------|----------------------------------|
| **A** | Contract subpaths; root errors-only; observe-wiki-run helpers | **done** |
| **B** | citation-target; pure validate + MechanicalIssue; publication/* split | **done** |
| **C** | WikiRunsControl; attempt-finish / inputs / publication-effect concentration | **done** |
| **D** | commitPlanDraft; no SpecStore; path-first review; materialize split; no produce/; plan deep module | **done** |
| **E** | server `sse/*` framing + subscribe modules | **done** |
| **F** | no AssistantTurn; URL selection; banWebStreamServer | **done** |
| **G** | this ADR + live-doc / historical-note sweep | **this delivery** |
