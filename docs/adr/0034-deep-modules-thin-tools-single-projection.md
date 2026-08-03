# Deep modules, thin tools, single projection, real ports

**Status:** accepted (ProgressSink / museum-store / SpecStore / web stream-server clauses historical — see status note)  
**Date:** 2026-07-28  
**Refines:** [ADR 0033](0033-run-graph-and-agent-layering.md) (ports DIP / layering), [ADR 0032](0032-pi-tool-owned-wiki-runs.md) (Pi tools own runs), [ADR 0031](0031-unidirectional-framework-first-operator-surface.md) (pure projection)  
**Related:** ADR 0029 (no-compat), codebase-design skill (deep modules / seam vocabulary), [ADR 0035](0035-durable-wikiruns-control-plane.md), [ADR 0041](0041-contract-subpaths-and-agent-port-thinning.md)  
**Does not supersede:** Pi Session authority (0032), Run Boundary in `@okf-wiki/core` (0019)  
**Superseded clauses by:** [ADR 0035](0035-durable-wikiruns-control-plane.md) (Run progress fan-out = Run SSE; durable control = WikiRuns); [ADR 0041](0041-contract-subpaths-and-agent-port-thinning.md) (contract subpaths; SpecStore deleted; Session browser projection; path-first review)  
**Index:** [docs/adr/README.md](README.md)

> **Status note / Superseded clauses (read first)**  
> Keep deep-module / thin-tool / single-projection / real-port **culture**. Strike museum fan-out, store ports, and dual web stream paths:
>
> - ~~**One fan-out: `ProgressSink`**~~ → **Current fan-out: Run SSE** (ADR 0035; separate from Operator Session SSE).  
> - ~~Keep `GraphStore` / `GatePort` / `ReceiptStore` as required agent ports~~ → **DELETED**; durable control is WikiRuns.  
> - ~~Remaining agent ports `AgentRunner` + `SpecStore`~~ → **`SpecStore` DELETED** (ADR 0041 / Epic D). Sole required agent port: **`AgentRunner`** (live + fixture). Plan draft I/O is deep module **`commitPlanDraft`**, not a port.  
> - ~~Contract “optional future `exports` subpaths; unexport is the API”~~ → **Subpaths done** (Epic A): business types only on `@okf-wiki/contract/{session,wiki-runs,coverage,stream-server,workspace,pi-attempt}`; root is errors-only.  
> - ~~Web applies `applyStreamPatch` / AgentMessage as browser true-source~~ → **Session browser projection** is true-source: `@okf-wiki/contract/session` + `applySessionStreamPatch` + `SessionTranscript`. `AgentMessage` / `reducePiEvent` / `applyStreamPatch` live under **`/stream-server` (server-only)**.  
> - Thin Pi tools → WikiRuns command dispatch remains current (§3). Attempt tools stay thin (schema + dispatch/commit); deep work is `plan/`, `review/`, runtime handlers.  
> - Path-first review only: `submit_defect_report` → `analysis/defect-report.json` (no free-text JSON admission).

## Context

After ADR 0033, the tree still accumulated **shallow surfaces** that fought locality and testability:

- `@okf-wiki/contract` mega-barrel re-exported internal helpers, deprecated schemas, and unused phase-transition helpers.
- Web kept zero-depth shims (`pi-message`) and hand-rolled snapshot projection beside contract `applyStreamPatch`.
- `wiki_repair` was a fat Pi tool (admission, locks, layout bootstrap, workflow) while `wiki_produce` stayed thin.
- `useSessionAgent` mirrored `status` / `error` in React state beside `streamStateRef`, with `clearError` bypassing the projector.
- ~~`ProgressSink` existed as a port but phases mostly called raw `onProgress` / `emitProgress` — a half-used seam.~~ **Historical:** ProgressSink deleted; Run observation is Run SSE.
- Core duplicated `LIST_LINK_RE` parsers; `citations.ts` mixed parse, canonicalize, resolve, and staging rewrite.
- Run Graph view-model computed `edges` the canvas never drew.

We needed explicit product rules aligned with 2025–2026 TypeScript / agent / React practice: **narrow package surfaces**, **thin tool adapters**, **bounded repair in workflow**, **single projection true-source**, **ports only when real**.

## Decision

### 1. Package public surface is intentional

- Contract (and core) barrels export **stable cross-package types and functions only**.
- Do not re-export: internal field schemas, deprecated transitional schemas, dead helpers, or test-only symbols.
- Prefer deleting zero-depth shims over “export regression” tests that only lock the shim.
- **Current (ADR 0041 / Epic A):** `package.json` `"exports"` **subpaths are the API**. Root `@okf-wiki/contract` is errors/metadata only; business types import from subpaths. Web must not import `/stream-server`.

### 2. Deep modules; real seams only

Vocabulary matches the codebase-design skill:

| Rule | Product application |
|------|---------------------|
| Deep module | Small interface, large behavior (e.g. Session stream reduce in contract, `commitPlanDraft`, repair loop in workflow) |
| One adapter ≈ false seam | Do not invent ports for documentation; delete unused port types (`WikiWriter`, ~~`SpecStore`~~) |
| Two adapters ≈ real seam | Keep **`AgentRunner`** only (live + fixture). ~~`SpecStore`~~ **DELETED** (ADR 0041). ~~`GraphStore` / `GatePort` / `ReceiptStore`~~ **DELETED** under ADR 0035. |
| Progress protocol | ~~**One** fan-out: `ProgressSink`.~~ **Current:** **Run SSE** is the sole Run progress fan-out (Snapshot + durable events after `Last-Event-ID`). Operator Session SSE stays redacted conversation projection only. Do not reintroduce ProgressSink or dual progress protocols. |

~~Core-backed stores (`SpecStore`, `ReceiptStore`, `GraphStore`) stay ports…~~ **Current:** **no** core-backed Spec store port. Plan draft commit is `commitPlanDraft` (deep module; injectable function = internal test seam). Analysis receipts and durable topology are not agent ports.

### 3. Pi tools are thin adapters

```
tools/*  →  WikiRuns command dispatch (StartRun / RerunNode) or deep commit  →  receipt
```

- `wiki_produce` / `wiki_repair`: schema + dispatch durable WikiRuns commands; return a receipt (ADR 0035). They do **not** own the whole Run or await gates.
- `submit_wiki_run_spec` / `submit_defect_report`: schema + `commitPlanDraft` / `commitDefectReport` (path-first file receipts).
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

- **Browser Session true-source (current):** server projects Pi → redacted Session DTO; web applies **Session snapshot + patches** via `@okf-wiki/contract/session` (`applySessionStreamPatch`). Live chat is `SessionTranscript`.
- ~~Web applies `applyStreamPatch` / AgentMessage as the conversation path~~ **historical** — those symbols are **server-only** under `@okf-wiki/contract/stream-server` (ADR 0041 / Epic F).
- Hook true sources:
  - Session stream state from contract Session patches (+ small local reducers such as clear-error / optimistic user dedupe)
  - hook-only `sending` ref for optimistic send (not part of contract stream state)
- Render **derives** `status` / `error` (error → streaming → sending → idle).
- `clearError` goes through the same publish path as stream updates (no ref-only bypass).
- Do not import server-only helpers (`reducePiEvent`, `AgentMessage`, `applyStreamPatch`) from web.
- Workbench selection is **URL-only** (no independent `surface` store).
- Run observation UI projects **Run SSE** / WikiRuns snapshots — not a ProgressSink client map and not Session events.

### 6. Core locality

- **One** wiki index listing parser authority (`parseWikiIndexListing` / `LIST_LINK_RE` in wiki-nav). Validate/regenerate project from it; no duplicate regex.
- Citations: parse vs canonicalize(/resolve) as separate modules; publish rewrite stays `citation-rewrite` adapter. Public barrel names may re-export for compatibility.
- Observation view-models must not compute dead outputs the UI never consumes (e.g. Run Graph `edges`).

### 7. No-compat

Per ADR 0029: delete shims and dual paths; update call sites and tests. Do not leave “deprecated barrel forever.”

## Consequences

- Contract surface is subpath-shaped; web Session logic lives next to Session stream patches (not stream-server).
- `wiki_repair` mirrors `wiki_produce` thickness; admission is unit-testable without Pi tool context.
- Operator session hook tests can target pure derive/reducers; fewer dual mocks.
- ~~Progress injection tests exercise the real phase path.~~ Run progress tests exercise WikiRuns / Run SSE.
- ADR 0033 port table: **`WikiWriter` removed**; museum ports **ProgressSink / GatePort / GraphStore / ReceiptStore / SpecStore removed**; remaining port **`AgentRunner` only** (ADR 0041).

## Out of scope (explicit)

- `live-session-registry` factory / god-struct split (high-risk server concurrency; separate epic).
- Full extraction of council/HV into formal `RepairPolicy` types (optional follow-up; loop + constants landed first).
- ~~Contract `exports` subpath split (optional).~~ **Done** under ADR 0041 / Epic A.
