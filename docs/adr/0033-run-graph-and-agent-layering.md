# Run Graph observation model and Agent layering (ports DIP)

**Status:** accepted  
**Date:** 2026-07-26  
**Refines:** [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md), [ADR 0032](0032-pi-tool-owned-wiki-runs.md)  
**Related:** ADR 0011 (file receipts), ADR 0019 (Run Boundary), ADR 0028 (thin shell + supervisor tree intent), ADR 0029 (no-compat)  
**Does not supersede:** Pi as Session authority (0032), Run Boundary ownership in `@okf-wiki/core` (0019), fail-closed reviewer resolution (0032)  
**Index:** [docs/adr/README.md](README.md)

## Context

ADR 0032 made `wiki_produce` the sole Wiki Run owner and Pi `SessionManager` the sole Session authority. Implementation then accumulated a large `produce/` surface that mixed orchestration shell, phase logic, prompts, redaction, and Pi adapters. Ports existed only partially (`AgentRunner`, `GraphStore`, `ProgressSink`), so workflow code still reached for concrete FS helpers and gate types lived next to Pi model factories.

We need a clear split between:

1. **Run Graph** — observation model (topology + append-only attempts), not an execution engine  
2. **Run Workflow** — orchestration shell and phases (plan → research → write → review/repair → gates)  
3. **Ports (DIP)** — injectable surfaces free of Pi SDK  
4. **Runtime / tools / session** — Pi boundary adapters

This is a **no-compat** layout move (ADR 0029): relocate modules and fix imports; do not leave dual paths or shim barrels under old paths.

## Decision

### 1. Run Graph is observation only

- Shape authority: contract `RunGraphSnapshot` (topology + attempts + optional playhead).  
- Live projection rides `wiki_produce` tool details via `ProgressSink` + `AttemptJournal`.  
- Durable copy lives under the Run Boundary (`analysis/run-graph.json`) through `GraphStore`.  
- The graph does **not** schedule agents, own HITL, or replace the Run Record.

### 2. Run Workflow owns orchestration

- Shell: `workflow/run-wiki.ts` — freeze → plan → plan gate → produce body → publication gate → publish.  
- Body: `workflow/produce.ts` + `workflow/phases/*` (including `plan-phase`).  
- Workflow production code **must not** import Pi SDK (`@earendil-works/*`), `tools/`, or `session/`.  
- Opaque model handles and `customTools` are injected from the tool edge.

### 3. Ports DIP (packages/agent/src/ports)

Ports stay free of Pi SDK, `produce/`, and `runtime/` implementation modules. Allowed: `@okf-wiki/contract`, `@okf-wiki/core` (adapters), local string unions, `unknown` for model/tool handles.

| Port | Role |
|------|------|
| `AgentRunner` | Scoped agent run + parallel + `writeWiki` |
| `GraphStore` | Durable Run Graph save/load |
| `ProgressSink` | Live progress emission (sole produce-phase fan-out; see [ADR 0034](0034-deep-modules-thin-tools-single-projection.md)) |
| `GatePort` | HITL `waitForDecision` (plan / publication) |
| `ReceiptStore` | Write / attach / buildIndex / list analysis receipts |
| `SpecStore` | commitSpec / readCommittedSpec / writePlanDraft / readPlanDraft |

Core-backed adapters (`createCoreGraphStore`, `createCoreReceiptStore`, `createCoreSpecStore`) implement ports with `@okf-wiki/core`. Memory fakes live in tests.

**Removed:** `WikiWriter` (`Pick<AgentRunner,"writeWiki">`) was a zero-adapter type alias — deleted per ADR 0034 (real seams only).

### 4. Agent package layout

```
agent/src/
  ports/       # DIP interfaces + core adapters
  workflow/    # Run shell + phases + journal + topology + run-graph-owner + run-node-attempt (no Pi)
  produce/     # Domain helpers: defects, review, publishability, wiki-pages only
  prompts/     # plan / domain / leaf / writer / reviewer / system
  runtime/     # Pi adapters: scoped-runner, fixture-runner, fs-operations, projectors/
  tools/       # Pi tool definitions (wiki_produce, wiki_repair, submit_wiki_run_spec, …)
  session/     # Operator Session open/create/delete + history projection
  redact/      # Operator-safe string redaction
```

- `runtime/scoped-runner.ts` — live `AgentRunner`  
- `runtime/fixture-runner.ts` — fixture / scripted review `AgentRunner`  
- `runtime/produce-runtime.ts` — thin `resolveProduceRuntime`  
- `runtime/projectors/` — attempt + assistant outcome projection  
- `runtime/fs-operations.ts` — FS tool operations (formerly tool-operations)

### 5. No compatibility shims

- Do not keep `produce/run-wiki.ts` or `produce/plan.ts` as re-export stubs.  
- Do not dual-write progress protocols or dual Spec writers.  
- Call sites update imports; tests inject ports rather than reaching through deleted paths.

## Consequences

- Architecture check enforces: ports free of Pi/produce; workflow free of Pi/tools/session.  
- Tool edge (`tools/wiki_produce`) injects plan `customTools` and gate coordinators into the workflow shell.  
- Research/write/review phases consume `ReceiptStore` (default Core adapter) instead of ad-hoc FS helpers.  
- Server continues to import gate types from `@okf-wiki/agent` (re-exported from ports via run-wiki).
