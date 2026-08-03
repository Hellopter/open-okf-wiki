# Architecture Hard-Cut Checklist (2026-08)

**Status:** Epics **0–G done** (2026-08-03 hard-cut). Control: WikiRunsControl + attempt-inputs + attempt-finish + publication-effect. Guard flags all on.  
**Authority:** Full hard-cut deepening plan (session plan 2026-08-03) · ADR 0029 / 0033 / 0034 / 0035 / 0039 / 0040 / **0041**  
**Guard:** [`scripts/check-architecture.mjs`](../../scripts/check-architecture.mjs) — `HARD_CUT_FLAGS` (**all on**: `banContractRootBusinessImport`, `banWebStreamServer`, `banDefaultSpecStore`, `banFreeTextDefectParse`)

---

## 1. Goal

Full **hard-cut deepening** of the monorepo architecture:

- Each identified friction becomes a **deep module** with a small interface and concentrated behaviour.
- **No dual paths**, **no shims**, **no deprecated re-exports**, **no “leave for six months”** half-cuts.
- Fake seams / museum APIs / duplicated policy are **deleted at merge**, not feature-flagged.
- Package dependency edges stay unidirectional; WikiRuns remains the only durable Run control plane.
- Every epic lands **source + tests + live docs** together so the tree is never “code hard-cut, docs teach old path.”

Not: small refactors, compatibility layers, or characterization tests that lock deleted APIs.

---

## 2. Locked decisions

| Decision | Choice |
|----------|--------|
| **Contract surface** | Hard-cut `package.json` `exports` **subpaths**; all consumers switch imports. |
| **Contract root** | **No business types** on `@okf-wiki/contract` root — errors / package metadata only (or empty). |
| **SpecStore** | **Delete** `SpecStore` port + `defaultSpecStore`. Replace with deep module **`commitPlanDraft`**. Composition may inject a function (internal seam only). |
| **Review admission** | **Path-first only** via `submit_defect_report` → `analysis/defect-report.json`. **Delete** free-text JSON fallback (`tryParseDefectReportJson`). |
| **Epic order** | **A → G** dependency-layered; **serial between epics**, **parallel within** an epic (subagents). Epic 0 locks the contract first. |
| **Publication order** | Epic **B** splits core publish first → Epic **C** consolidates workflow Effect. |
| **AgentRunner** | **Keep** port (live + fixture = real seam). |
| **Tests** | Co-cleaned with source. Delete dead tests; rewrite to new interface. If **>~1/3** of cases fail due to rename/deleted dual-path, **rewrite the whole file**. Never keep dead product code “for green tests.” |
| **Docs** | Co-updated **per epic**. Live maps always correct; historical ADR/research get status notes — not treated as current architecture. |
| **Delivery** | Source + tests + relevant live docs in the **same** epic delivery. No transition shim directories. |

### SpecStore replacement (locked shape)

```
commitPlanDraft(runWorkDir, spec, { coveragePlan?, caps? })
  → assertCoverage / fan-out caps / Zod
  → atomic write plan-draft.json
  → return path + receipt fields
```

- Tool = TypeBox schema + call `commitPlanDraft`
- Handler/tool factory may inject the function for tests = **internal seam**, not `ports/SpecStore`
- **Keep** `AgentRunner`

### Non-goals (do not re-open)

- WikiRuns remains sole durable Run control; Pi does not own Run or await gates (0035/0039)
- Do not resurrect ProgressSink / RunGraph museum / GatePort / ReceiptStore
- Do not put Pi SDK into `workflow/`
- Do not rename Publication Effect states (prepared → candidate_ready → applying → applied)
- Do not introduce per-table StoragePort / generic workflow engine
- Do not merge Session SSE and Run SSE
- Do not thicken `wiki_produce` / `wiki_repair` back into full Run ownership

---

## 3. Epic order and status

```
Epic 0  Guards + acceptance contract          [done]
   ↓
Epic A  contract subpaths + observe/coverage  [done]
   ↓
Epic B  core: citation-target + validate + publication split  [done]
   ↓
Epic C  workflow: control ctx + attempt-finish + inputs + effect  [done]
   ↓
Epic D  agent: plan deepen + thin tools + SpecStore out + review single path + produce cleanup  [done]
   ↓
Epic E  server: SSE subscribe modules + operator-sessions slim  [done]
   ↓
Epic F  web: selection / observation / session projection hard-cut  [done]
   ↓
Epic G  docs final + ADR 0041 + all guards on + sweep  [docs done — ADR 0041 + L0/L3]
```

| Epic | Scope (one line) | Status |
|------|------------------|--------|
| **0** | Checklist + `HARD_CUT_FLAGS` skeleton | **done** |
| **A** | Contract exports subpaths; observation helpers; museum barrel out | **done** |
| **B** | Citation target one policy; pure validate; publication modules | **done** |
| **C** | Single control ctx; attempt-finish / inputs / publication-effect | **done** |
| **D** | `commitPlanDraft`; delete SpecStore; path-first review; drop `produce/` | **done** |
| **E** | Shared SSE framing + subscribe modules; split operator-sessions | **done** |
| **F** | URL-only selection; pure reduce hooks; delete AgentMessage UI museum | **done** |
| **G** | ADR 0041; L0 final sweep; L3 historical notes; all guards on | **docs done** (flags already on from A/D/F) |

**Principle:** stabilize upstream interfaces first, then delete downstream copies. Epics are **serial**; within an epic, non-conflicting tasks may run in parallel. Epic C must not race other work on the same workflow files.

---

## 4. Epic completion gates

Every epic merge must satisfy **all** of:

### Source

- [ ] Target deep modules land with a clear external interface
- [ ] Items on this epic’s **source deletion list** are gone (no `// deprecated`, no shim dir)
- [ ] No dual path for the behaviour this epic owns
- [ ] Package import edges still pass `check-architecture` (existing rules + any flags this epic turns on)

### Tests

- [ ] No test imports deleted symbols (compile fails if they do)
- [ ] New modules have **interface-level** tests
- [ ] This epic’s test disposition rows are done (delete / rewrite / keep)
- [ ] No skip/empty/`only` fake greens
- [ ] Affected package `pnpm test` green; relevant e2e subset green when UI/SSE touched

### Live docs

- [ ] L0 / L1 paths listed for this epic updated (see §7)
- [ ] Live maps do not teach deleted APIs
- [ ] Skill refs / prompts updated when behaviour changes (especially Epic D)

### Guard flags (turn on when the epic’s ban is true in tree)

| Flag | Enable after |
|------|----------------|
| `banContractRootBusinessImport` | Epic **A** |
| `banWebStreamServer` | Epic **F** (enabled) |
| `banDefaultSpecStore` | Epic **D** |
| `banFreeTextDefectParse` | Epic **D** |

Epic **G** turns **all** flags on and does a repo-wide `rg` sweep for high-risk old words in live docs.

---

## 5. Source deletion list (per epic)

Symbols/paths that **must be deleted** (or cease to exist as product surface) when that epic merges. Expand during implementation if more museum residue appears.

### Epic 0 — Guards only

| Delete / ban | Notes |
|--------------|--------|
| *(none yet)* | Document + flag skeleton only; flags remain `false` |

### Epic A — Contract

| Delete / move | Notes |
|---------------|--------|
| Business re-exports from `packages/contract/src/index.ts` root | Root = errors/metadata only |
| Root path for `applyStreamPatch` / `AgentMessage` / `reducePiEvent` as browser surface | Live under `@okf-wiki/contract/stream-server` only |
| Web-local kind→stage arrays duplicated from contract | Replaced by `observeWikiRun` helpers on `/wiki-runs` |
| Comments claiming web live SSE reduces via full AgentMessage | Session stack is truth (0039) |

**Target subpaths (create, not delete):**  
`/session`, `/wiki-runs`, `/coverage`, `/stream-server` (**server-only**), `/workspace`, `/pi-attempt`

### Epic B — Core

| Delete / consolidate | Notes |
|----------------------|--------|
| Private citation splitters in `validate-wiki` / `citation-rewrite` | Single `citation-target` policy |
| Silent disk autofix inside default `validateWikiTree` path | Autofix becomes explicit second step |
| English-string heuristics in `mechanical-report` that guess codes | Prefer structured `MechanicalIssue[]` |
| Monolithic `publish.ts` god-module (~740 lines) | Split: `publication/{digest,lock,materialize,apply}`; no shallow facade unless ≤2 call sites |
| Duplicate ordinary-tree walkers / private path-containment variants | Shared `walkOrdinaryTree` + `isPathInside` |

### Epic C — Workflow

| Delete / consolidate | Notes |
|----------------------|--------|
| Host zoo: `SchedulerHost`, `CommandsHost`, `AttemptSuccessHost`, `GatesHost`, `EffectsHost`, `FreezeHost`, `MechanicalHost`, `RepairScheduleHost`, … as product shape | Single `WikiRunsControl` / CasCtx-based ctrl |
| Owner `xxxHost()` factory methods on WikiRuns shell | Thin open → build ctrl → schedule → dispatch |
| Attempt input binding logic living in `artifacts.ts` | Move to `attempt-inputs` |
| Publication Effect transitions scattered across gate/mechanical/effects | Own in `publication-effect` |
| Dual hubs `attempt-success` vs `scheduler.failNode` as separate policy homes | Unify under `attempt-finish` |

### Epic D — Agent

| Delete | Notes |
|--------|--------|
| `packages/agent/src/ports/spec-store.ts` (`SpecStore`) | |
| `packages/agent/src/ports/core-spec-store.ts` (`createCoreSpecStore`, `defaultSpecStore`) | |
| `defaultSpecStore` call sites (`submit-wiki-run-spec`, `plan-phase`, …) | Use `commitPlanDraft` |
| `tryParseDefectReportJson` in `runtime/attempt/handlers/review.ts` | Path-first only |
| Free-text chat JSON defect assembly | |
| `packages/agent/src/produce/**` directory | Relocate `wiki-pages` if still needed; no empty produce layer |
| Fat tool bodies for coverage/draft I/O | Deep modules; tools = schema + dispatch |

### Epic E — Server

| Delete / move out of routes | Notes |
|-----------------------------|--------|
| Long poll/cursor loops embedded in `routes/wiki-runs.ts` | → `sse/*` subscribe modules |
| Duplicated `writeSse` / heartbeat dialects | Shared `sse/framing` |
| Monolithic responsibilities crammed only in `operator-sessions.ts` | Split by lifecycle / commands / project (no new port) |

### Epic F — Web

| Delete | Notes |
|--------|--------|
| Independent React `surface` selection store as authority | Derive from URL (`?session&run&attempt`) |
| `AssistantTurn.tsx` + AgentMessage-bound tool-call adapters | Live path is Session transcript |
| `packages/web/.../tool-call.ts` museum path for `AgentMessage` | |
| Web imports of `AgentMessage`, `reducePiEvent`, `applyStreamPatch`, `@okf-wiki/contract/stream-server` | |
| Merged connection badge that conflates Session SSE and Run SSE | One indicator per domain |

### Epic G — Sweep

| Delete / annotate | Notes |
|-------------------|--------|
| Remaining live-doc claims of deleted APIs | Status notes or rewrite |
| Stale `tmp/wiki/**` as if product norm | Mark stale or rebuild separately |
| Any leftover shim / dual-path comment | Final `rg` clean |

---

## 6. Test disposition (starter)

Rules:

1. **Interface is the test surface** — assert through the new module interface, not private Host shapes.
2. **Replace, don’t layer** — if production symbols are gone, delete the tests that locked them.
3. **Rewrite threshold** — if **>~1/3** of cases fail only because of rename / deleted dual path / Host shape, **rewrite the whole file**.

| Path / pattern | Disposition | Epic | Notes |
|----------------|-------------|------|-------|
| `packages/agent/src/ports/core-spec-store.test.ts` | **delete** / rewrite as `commitPlanDraft` tests | D | SpecStore port dies |
| `packages/agent/src/workflow/phases/plan-parse.test.ts` (defaultSpecStore) | **rewrite** → `commitPlanDraft` | D | |
| `packages/agent/**/handlers/review.test.ts` free-text branches | **delete** those cases | D | Keep tool/draft path only |
| `packages/web/**/tool-call.test.ts` (AgentMessage) | **delete** | F | With AssistantTurn museum |
| `packages/workflow/**/should-auto-retry-research.test.ts` (`SchedulerHost`) | **rewrite** | C | Move to attempt-finish pure / control fixture |
| `packages/workflow/src/wiki-runs/__tests__/*` Host assembly brittle suites | **rewrite** entry if Host-only red | C | Prefer control fixture; do not mechanical `s/Host/Ctrl/` |
| `packages/contract/**/agent-stream*` tests | **keep**, re-home import to `stream-server` | A | Web must not re-test `applyStreamPatch` as browser path |
| web e2e | **keep** behaviour; update selectors | F | Do not preserve e2e for old surface state |

### Per-epic test gate (repeat)

- [ ] No imports of deleted symbols  
- [ ] New interface tests exist  
- [ ] Disposition rows for this epic closed  
- [ ] Package tests green  

---

## 7. Doc disposition (L0 / L1 / L3)

### Levels

| Level | Meaning | Policy |
|-------|---------|--------|
| **L0** live map | Default entry for humans/agents — always correct | Patch **every** epic that changes layout |
| **L1** current ADR | Still constrains implementation | Status note + fix stale body; new ADR if needed |
| **L2** historical ADR | Superseded | Status note only; no full rewrite |
| **L3** research/design snapshot | Analysis of the day, not norm | `> Historical snapshot (YYYY-MM)` at top |
| **L4** generated wiki | e.g. `tmp/wiki/**` | Stale mark / rebuild; never product norm |
| **L5** skill / prompts | Model-facing method | Same PR as behaviour change |

### L0 live maps

| Path | Disposition | Primary epic(s) |
|------|-------------|-----------------|
| `README.md` | **patch** — subpath import one-liner; package roles | A, G |
| `CONTEXT.md` | **patch** — drop SpecStore/produce/wrong ownership notes; add domain words only if cross-package | D, G |
| `packages/README.md` | **patch** — contract audience table; no produce/; no SpecStore; workflow control one-liner | A, C, D, G |
| `docs/adr/README.md` | **patch** — shortlist + 0041 | A, G |
| `docs/agents/domain.md` | **patch** — align with CONTEXT | G (incremental if needed) |
| `AGENTS.md` | **patch** if layout/commands assumptions change | G |
| `packages/web/README.md` | **patch** — Session vs Run; no AgentMessage; URL selection | F, G |
| `scripts/check-architecture.mjs` (header / hard-cut section) | **patch** — forbidden rules as executable docs | 0, G |
| **This file** | **patch** — status checkboxes | 0…G |

### L1 current ADRs

| Path | Disposition | Primary epic(s) |
|------|-------------|-----------------|
| `docs/adr/0034-deep-modules-thin-tools-single-projection.md` | **patch** — Session patch as web truth; subpaths done; SpecStore deleted; thin tools; no free-text review | A, D, F, G |
| `docs/adr/0033-run-graph-and-agent-layering.md` | **patch** — no produce/; ports = AgentRunner only | D, G |
| `docs/adr/0039-browser-operator-session-and-run-observation.md` | **patch** — URL selection; no dual surface store | F, G |
| `docs/adr/0035-durable-wikiruns-control-plane.md` | **optional note** — internal locality only; external commands/SSE unchanged | C, G |
| `docs/adr/0031-unidirectional-framework-first-operator-surface.md` | **patch** — subpath consumption; web ↛ stream-server | A, G |
| `docs/adr/0040-use-coverage-units-*.md` | **optional note** if `HostCoverageInventory` naming lands | A/B, G |
| **ADR 0041** | **done** — [0041-contract-subpaths-and-agent-port-thinning](../adr/0041-contract-subpaths-and-agent-port-thinning.md): exports hard-cut, no business root, SpecStore out, path-first review, Session browser projection, WikiRunsControl direction, test/doc hard-cut | G |

### L3 research / design snapshots

| Path | Disposition | Epic |
|------|-------------|------|
| `docs/research/agent-ui-event-projection.md` | **historical note** → current 0039 + contract/session | G |
| `docs/research/*wiki-workflow*` / `*pi-architecture*` / hard-cut prep | **historical note** | G |
| `docs/design/project-audit-and-fix-plan-2026-07.md` | **historical note** (superseded items optional short table) | G |
| Other `docs/research/*` | Default skip body; G scan for SpecStore / web `applyStreamPatch` claims | G |
| `docs/design/ux-ui-refactor-plan-2026-07.md` | **historical** if it teaches dual selection | G |
| **This checklist** | **live** until G closes hard-cut; then keep as design record | 0–G |

### Docs × epic (must not pile only on G)

| Epic | Docs that must move with the code |
|------|-----------------------------------|
| **0** | This checklist (source/test/doc disposition) |
| **A** | `packages/README.md` subpath table; README import hint; 0034/0031 notes |
| **B** | `packages/README` Run Boundary one-liner; CONTEXT if citation impl notes |
| **C** | `packages/README` workflow control modules; optional 0035 note |
| **D** | 0033/0034 body; skill `review.md` / `plan.md`; agent prompts |
| **E** | packages/README SSE subscribe one-liner if described |
| **F** | `packages/web/README.md`; 0039 selection; 0034 web projection |
| **G** | ADR 0041; full L0 sweep; L3 historical batch; CONTEXT vocab check |

---

## 8. Forbidden symbols (`check-architecture`)

Executable bans live in `scripts/check-architecture.mjs` under `HARD_CUT_FLAGS`. **Do not enable a flag until the corresponding epic has deleted the residue.**

| Flag | When true, fail on… | Enable after |
|------|---------------------|--------------|
| `banContractRootBusinessImport` | Product source under `packages/{web,server,agent,workflow,core}/src` importing bare `"@okf-wiki/contract"` / `'@okf-wiki/contract'` (subpaths allowed; contract package itself exempt) | A |
| `banWebStreamServer` | `packages/web` importing `stream-server`, or symbols `AgentMessage`, `reducePiEvent`, `applyStreamPatch` | A / F |
| `banDefaultSpecStore` | `defaultSpecStore` under `packages/agent/src` | D |
| `banFreeTextDefectParse` | `tryParseDefectReportJson` | D |

### Broader forbidden vocabulary (Epic G `rg` + future flags)

Use for doc/code sweeps; not all are automated on Day 0:

- `SpecStore`, `createCoreSpecStore`, `defaultSpecStore`
- `tryParseDefectReportJson`, free-text defect JSON admission
- Bare `@okf-wiki/contract` business barrel usage
- Web: `AgentMessage`, `reducePiEvent`, `applyStreamPatch`, `AssistantTurn` product path
- Host zoo types as the public control seam (`SchedulerHost` product surface after C)
- `packages/agent/src/produce/` as a live layer
- Dual selection store / surface authority beside URL

Existing museum bans in `check-architecture.mjs` (ProgressSink, ReceiptStore, WikiRunShell, …) remain in force independently of `HARD_CUT_FLAGS`.

---

## 9. Target architecture (post hard-cut sketch)

```
@okf-wiki/contract
  /session        browser Session wire + applySessionStreamPatch
  /wiki-runs      commands, snapshot, observation helpers, node-contract stage
  /coverage       assertCoverage + unit ids
  /stream-server  reducePiEvent / AgentMessage (server-only)
  /workspace      workspace config shapes
  (root "." — no business types; errors/metadata only)

@okf-wiki/core          Run Boundary
  citation-target       sole target policy
  validate              pure model → MechanicalIssue[]
  publication/{digest,lock,materialize,apply}
  walk-ordinary-tree    shared ordinary-tree adapter

@okf-wiki/workflow      WikiRuns
  openWikiRuns          thin shell: DB, schedule loop, close
  control-ctx           sole CasCtx + control primitives
  attempt-finish        sealed outcome → gates/repair/run-state
  attempt-inputs        “what sealed inputs this node mounts”
  publication-effect    Effect state machine in one place

@okf-wiki/agent
  tools/*               thin: schema + dispatch/commit
  workflow/plan         deep plan module
  runtime/mount         sealed mount
  runtime/projection    loaders
  (no produce/; no SpecStore; no free-text review)

@okf-wiki/server
  sse/*                 framing + subscribeRun / subscribeTranscript
  operator-sessions     open/project/command split

@okf-wiki/web
  session-conversation  pure reduce + thin hook
  run-observation       pure reduce + thin hook
  selection             URL sole authority
```

---

## 10. Status board

| Epic | Status | Notes |
|------|--------|--------|
| **0** | **done** | Checklist + `HARD_CUT_FLAGS` skeleton landed; flags later enabled per epic |
| **A** | **done** | Subpath exports; root errors-only; observe-wiki-run helpers; `banContractRootBusinessImport` on |
| **B** | **done** | citation-target; pure validate + MechanicalIssue; publication/{digest,lock,materialize,apply} |
| **C** | **done** | `WikiRunsControl`; `attempt-inputs`; `attempt-finish` (success+fail); `publication-effect` SM; Host zoo deleted |
| **D** | **done** | `commitPlanDraft`; SpecStore deleted; path-first review; no `produce/`; plan deep module; `banDefaultSpecStore` + `banFreeTextDefectParse` on |
| **E** | **done** | server `sse/*` framing + run/index/transcript subscribe modules |
| **F** | **done** | URL selection; museum AssistantTurn/tool-call deleted; `banWebStreamServer` on |
| **G** | **docs done** | [ADR 0041](../adr/0041-contract-subpaths-and-agent-port-thinning.md); L0 maps + 0033/0034 notes; L3 historical notes on Session projection research; all four hard-cut flags on |

**Epic 0 exit criteria**

- [x] This checklist exists under `docs/design/architecture-hard-cut-2026-08.md`
- [x] Source deletion lists, test disposition, doc disposition, forbidden symbols recorded
- [x] `HARD_CUT_FLAGS` present in `check-architecture.mjs` (initially all `false`; now all `true` after A/D/F)
- [x] `node scripts/check-architecture.mjs` passes with current flags

**Epic G docs exit (this delivery)**

- [x] ADR 0041 accepted
- [x] ADR 0033 / 0034 status notes match tree (no SpecStore; Session projection; no produce/)
- [x] `docs/adr/README.md` shortlist includes 0041
- [x] `packages/README.md` workflow/agent one-liners current
- [x] L3 historical notes on research that taught web `applyPiEvent` / AgentMessage as true-source
- [x] Epic C attempt-finish / inputs / publication-effect closed in source
