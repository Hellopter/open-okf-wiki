# Run Graph observation model and Agent layering (ports DIP)

**Status:** accepted (partially historical — see status note)  
**Date:** 2026-07-26  
**Refines:** [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md), [ADR 0032](0032-pi-tool-owned-wiki-runs.md)  
**Related:** ADR 0011 (file receipts), ADR 0019 (Run Boundary), ADR 0028 (thin shell + supervisor tree intent), ADR 0029 (no-compat), [ADR 0041](0041-contract-subpaths-and-agent-port-thinning.md)  
**Does not supersede:** Pi as Session authority (0032), Run Boundary ownership in `@okf-wiki/core` (0019), fail-closed reviewer resolution (0032)  
**Superseded clauses by:** [ADR 0035](0035-durable-wikiruns-control-plane.md) (durable WikiRuns control; Run SSE); [ADR 0041](0041-contract-subpaths-and-agent-port-thinning.md) (`SpecStore` deleted; no `produce/` layer; ports = `AgentRunner` only)  
**Index:** [docs/adr/README.md](README.md)

> **Status note / Superseded clauses (read first)**  
> Under [ADR 0035](0035-durable-wikiruns-control-plane.md), the durable Run control plane is **WikiRuns**, not the in-process museum below. The `RunGraphSnapshot` contract was hard-deleted in protocol v3. Treat as **DELETED / historical** (do not reintroduce):
>
> | Historical (0033 era) | Current (0035 / 0041) |
> |-----------------------|----------------|
> | `ProgressSink` live fan-out on `wiki_produce` details | **Run SSE** (secret-free Snapshot + durable events) |
> | `GraphStore` + `analysis/run-graph.json` | WikiRuns Nodes / Attempts / lineage in control store |
> | `RunGraphSnapshot` + `runGraphToViewModel` | WikiRuns snapshot + direct `wikiRunToViewModel` projection |
> | `GatePort` in-process HITL wait | WikiRuns typed Gates + `ResolveGate` |
> | `ReceiptStore` port as produce I/O seam | Analysis receipts remain Run Boundary artifacts; not a required agent port |
> | `workflow/run-wiki.ts` freeze→plan→gates shell | WikiRuns definition DAG + thin Pi tools (`StartRun` / `RerunNode` receipt) |
> | `SpecStore` agent port | **DELETED** — `commitPlanDraft` deep module (ADR 0041 / Epic D) |
> | `produce/` package layer | **DELETED** — helpers under `runtime/` / phases; no produce directory |
>
> **Still current from this ADR:** ports DIP culture; workflow free of Pi SDK; **`AgentRunner` only** (live + fixture); session/runtime/tools split; no compatibility shims. Layout no longer includes `produce/`.
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

- ~~Shape authority: contract `RunGraphSnapshot` (topology + attempts + optional playhead).~~ **Historical / DELETED:** WikiRuns snapshot is the sole control read model.
- ~~Live projection rides `wiki_produce` tool details via `ProgressSink` + `AttemptJournal`.~~ **Historical:** live Run progress is **Run SSE** under ADR 0035.  
- ~~Durable copy lives under the Run Boundary (`analysis/run-graph.json`) through `GraphStore`.~~ **Historical:** durable topology is WikiRuns control records.  
- The graph does **not** schedule agents, own HITL, or replace the Run Record.

### 2. Run Workflow owns orchestration

- ~~Shell: `workflow/run-wiki.ts` — freeze → plan → plan gate → produce body → publication gate → publish.~~ **Historical / DELETED:** durable shell is WikiRuns definition + commands; Pi tools only dispatch (`StartRun` receipt).  
- Body: attempt-local phase helpers under `workflow/` / `runtime` (plan, research, write, review) for the discardable Pi Attempt executor — **not** a second Run owner.  
- Workflow production code **must not** import Pi SDK (`@earendil-works/*`), `tools/`, or `session/`.  
- Opaque model handles and `customTools` are injected from the tool edge / attempt composition.

### 3. Ports DIP (packages/agent/src/ports)

Ports stay free of Pi SDK and `runtime/` implementation modules. Allowed: `@okf-wiki/contract` subpaths, `@okf-wiki/core` (adapters where needed), local string unions, `unknown` for model/tool handles.

| Port | Role | Status |
|------|------|--------|
| `AgentRunner` | Scoped agent run + parallel + `writeWiki` | **Current** (sole required agent port) |
| `SpecStore` | commitSpec / readCommittedSpec / writePlanDraft / readPlanDraft | **DELETED** (ADR 0041 — use `commitPlanDraft`) |
| `GraphStore` | Durable Run Graph save/load | **DELETED** (WikiRuns) |
| `ProgressSink` | Live progress emission | **DELETED** (Run SSE) |
| `GatePort` | HITL `waitForDecision` (plan / publication) | **DELETED** (WikiRuns Gates) |
| `ReceiptStore` | Write / attach / buildIndex / list analysis receipts | **DELETED** as required agent port |

~~Core-backed `SpecStore` adapter remains.~~ **Deleted** with the port (Epic D). ~~`createCoreGraphStore` / `createCoreReceiptStore`~~ historical. Memory fakes live in tests for **`AgentRunner`** only.

**Removed earlier:** `WikiWriter` (`Pick<AgentRunner,"writeWiki">`) was a zero-adapter type alias — deleted per ADR 0034 (real seams only).

### 4. Agent package layout

```
agent/src/
  ports/       # DIP interfaces — AgentRunner only
  plan/        # commitPlanDraft deep module (no SpecStore)
  review/      # commitDefectReport deep module (path-first)
  workflow/    # Attempt-local phases + helpers (no Pi; no whole-Run shell)
  prompts/     # plan / domain / leaf / writer / reviewer / system
  runtime/     # Pi adapters: scoped-runner, fixture-runner, mount, projectors/, handlers
  tools/       # Thin Pi tools (wiki_produce, wiki_repair, submit_* → dispatch/commit + receipt)
  session/     # Operator Session open/create/delete + history projection
  redact/      # Operator-safe string redaction
```

- **No `produce/` directory** (ADR 0041 / Epic D). Wiki page helpers live under `runtime/` (e.g. `wiki-pages`).
- `runtime/scoped-runner.ts` — live `AgentRunner`  
- `runtime/fixture-runner.ts` — fixture / scripted review `AgentRunner`  
- `runtime/projectors/` — attempt + assistant outcome projection  
- Attempt handlers under `runtime/attempt/` materialize sealed mounts and run phase work

### 5. No compatibility shims

- Do not keep `produce/run-wiki.ts` or `produce/plan.ts` as re-export stubs — **produce/ is gone**.  
- Do not dual-write progress protocols or dual Spec writers.  
- Do not reintroduce ProgressSink / GatePort / GraphStore / ReceiptStore / SpecStore / run-wiki shell.  
- Call sites update imports; tests inject `AgentRunner` (and `commitPlanDraft` function seams) rather than deleted paths.

## Consequences

- Architecture check enforces: ports free of Pi; workflow free of Pi/tools/session.  
- Tool edge (`tools/wiki_produce`) dispatches WikiRuns `StartRun` and returns a receipt (ADR 0035); it does not own the whole Run.  
- Durable gates, events, and Run observation are WikiRuns + Run SSE — not agent-port fan-out.  
- **`AgentRunner` alone** remains the primary injectable agent port (ADR 0041).
