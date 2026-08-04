# Claude Dynamic Workflow 与 Coding Agent 实现选型

**Date:** 2026-08-04  
**Status:** Research note only. Not an ADR or implementation plan.  
**Branch:** `docs/claude-dynamic-workflow-research-2026-08`  
**Scope:** Greenfield thinking for **source → wiki** (and similar multi-stage coding-agent jobs). **Does not** prescribe changes to the current open-okf-wiki product stack.

**Local clones (analysis snapshot):** `tmp/claude-dw-research/` (gitignored / disposable; re-clone if needed).

---

## 1. Question

1. What do open-source **Claude Dynamic Workflow** ecosystems actually implement (2026)?
2. For a **coding agent** product (or plugin) that needs multi-stage parallel work without drowning the orchestrator context: should we ship a **Pi-style dynamic-workflow plugin/extension**, or **plain JS workflow scripts** (+ thin host), or something else?
3. How should we **bound the main orchestrator’s context** so fan-out does not cause overflow or attention rot? (See [§6](#6-orchestrator-context-budget).)

---

## 2. Executive recommendation

| Choice | Recommendation |
|--------|----------------|
| **Default for coding-agent users** | **JS workflow scripts + thin runtime** (Claude Code–compatible shape: `agent` / `parallel` / `pipeline` / `phase` + schema handoffs). Deliver as **installable scripts + Skill**, not a heavy product control plane. |
| **If the host is Pi** | Prefer a **Pi extension/plugin** in the style of `pi-dynamic-workflows` (or adopt/vendor that package), because Pi already owns sessions, tools, and subagents. |
| **If the host is Claude Code** | **No custom runtime** — use native Dynamic Workflows + project `.claude/workflows/*.js` + a Producer Skill. |
| **If multi-host (Codex / Cursor / OpenCode / CI)** | **Portable JS scripts + small daemon** (ODW-shaped) *or* host-native subagents + Skill discipline (`ultracode-skill`). Do not invent a fourth graph framework. |
| **Source → wiki specifically** | **Skill (method) + JS pipeline (topology) + host scripts (freeze / validate / publish)**. Single writer; research fan-out only; file receipts, not transcript aggregation. |
| **Main orchestrator context** | **Never hold child transcripts or full findings.** Hold goals, indexes, path lists, budgets. Intermediate state in script variables / disk / journal. See [§6](#6-orchestrator-context-budget). |

**One line:**  
*Ship **workflow as code** (JS) for orchestration; ship **Skill** for method; use a **plugin/extension only when the host needs a runtime inject** (Pi/ODW). Do not build a second durable “wiki runs museum” unless you need multi-tenant product ops. Keep the orchestrator’s context **O(index)**, not O(all evidence).*

---

## 3. Open-source landscape (cloned 2026-08, commits ~2026-05 → 2026-07)

### 3.1 Repos analyzed

| Repo | Role | Last activity (local clone) |
|------|------|-----------------------------|
| [QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) | Full **runtime** on Pi (~17k LOC TS): journal, model tiers, worktrees, verify helpers | 2026-07-31 |
| [Suraj1235/open-dynamic-workflows](https://github.com/Suraj1235/open-dynamic-workflows) | **Host-agnostic daemon**: QuickJS sandbox, SQLite resume, multi-editor adapters | 2026-07-09 |
| [lxcong/TradingFlow](https://github.com/lxcong/TradingFlow) | Complex **workflow script** (multi-phase finance swarm) | 2026-06-02 |
| [wesammustafa/Claude-Code-Everything-You-Need-to-Know](https://github.com/wesammustafa/Claude-Code-Everything-You-Need-to-Know) | Guide + real `.claude/workflows/stale-docs-audit.js` | 2026-07-28 |
| [FlorianBruniaux/claude-code-ultimate-guide](https://github.com/FlorianBruniaux/claude-code-ultimate-guide) | Docs: when Agent vs Skill vs Workflow | 2026-07-30 |
| [PabloNAX/ultracode-skill](https://github.com/PabloNAX/ultracode-skill) | **Skill only** (no runtime): plan / packets / integrate on disk | 2026-06-15 |
| [lxcong/awesome-claude-dynamic-workflows](https://github.com/lxcong/awesome-claude-dynamic-workflows) | Curated install list (TradingFlow graduated) | 2026-06-02 |

### 3.2 Three layers (do not conflate)

```text
┌──────────────────────────────────────────────────────────┐
│ L3 Method          Skill / SKILL.md / references          │
├──────────────────────────────────────────────────────────┤
│ L2 Topology        JS workflow script (phases, fan-out)   │
├──────────────────────────────────────────────────────────┤
│ L1 Runtime         host that executes agent()/parallel()  │
│                    Claude Code native | Pi extension | ODW │
├──────────────────────────────────────────────────────────┤
│ L0 Host boundary   freeze / path policy / validate / pub  │
└──────────────────────────────────────────────────────────┘
```

Open source fills **L1–L2** well; **L0** (publish gates, citation resolve) is always product-specific.

### 3.3 Shared architecture consensus

1. **Script is the orchestrator** — model writes or loads JS once; runtime runs it; chat does not babysit N agents turn-by-turn.
2. **Intermediate state lives outside the main LLM context** — script variables, SQLite/journal, files.
3. **Subagents have isolated sessions** — only distilled returns (ideally schema-validated) re-enter the script.
4. **Primitives converge:** `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, plus quality helpers (`verify`, `gate`, …).
5. **Structured handoff beats prose** — JSON Schema on `agent()` options.
6. **Adversarial / multi-lens verify** is a first-class pattern (stale-docs refute; ODW/pi `verify`).
7. **Resume** is table-stakes for long runs (journal by deterministic call id).

### 3.4 Shared failure mode (orchestrator tax 2.0)

Even with script orchestration, **downstream `agent(prompt)` still bloats** if authors do:

```js
// Anti-patterns seen in popular scripts
transcript += bull + bear          // TradingFlow-style accumulation
JSON.stringify(allFindings).slice(0, 30000)  // ODW deep-research example
```

ODW’s own `context-compact.js` documents that **blind slice breaks JSON**; correct approach is whole-element drop + manifest, or better: **write files, pass paths**.

**Implication:** Dynamic Workflow solves *main chat* pollution; it does **not** automatically solve *worker prompt* pollution. Source→wiki must add a **file data plane**.

### 3.5 Pattern catalog worth keeping

| Pattern | Best reference | Use for wiki |
|---------|----------------|--------------|
| Fan-out + schema extract | `stale-docs-audit.js` | Survey units → receipts |
| Pipeline without barrier | same | Scan file A while verifying B |
| Refute-by-default verify | same | Citation / grounding review |
| Fan-out ledger incl. failures | pi-DW `fan-out-and-synthesize.js` | Coverage completeness |
| Structure-preserving compact | ODW `context-compact.js` | Any forced in-prompt payload |
| Skill-only packets on disk | `ultracode-skill` | Hosts without DW runtime |
| Multi-phase role pipeline | TradingFlow | Research→plan→write→review (but **no multi-writer**) |

---

## 4. Decision: Pi dynamic-wf **plugin** vs **JS** for coding agents

### 4.1 What “plugin” vs “JS” means

| Artifact | What the user installs | Who executes `agent()` |
|----------|------------------------|-------------------------|
| **JS workflow only** | `.js` under host workflows dir (e.g. `.claude/workflows/`) | Host native runtime (Claude Code) |
| **Pi plugin / extension** | npm package + Pi extension (e.g. `@quintinshaw/pi-dynamic-workflows`) | Extension injects globals + spawns Pi sessions |
| **Portable daemon (ODW)** | `odw-daemon` + adapters | Local daemon + model HTTP |
| **Skill-only** | `SKILL.md` + conventions | Host subagents or single session |

### 4.2 Comparison for coding-agent delivery

| Criterion | JS scripts (Claude-native shape) | Pi DW plugin/extension | ODW daemon | Skill-only |
|-----------|----------------------------------|-------------------------|------------|------------|
| Install friction | Lowest on Claude Code | Low if already on Pi | Medium (daemon + config) | Lowest everywhere |
| Reproducible topology | High | High | High | Low–medium |
| Context isolation | Host-dependent (good on Claude DW) | Strong (designed in) | Strong | Weak unless host subagents |
| Resume / journal | Claude native / extension | Strong | Strong (SQLite) | DIY files |
| Multi-host | Scripts not portable 1:1 | Pi-locked | Best | Best method portability |
| Maintenance | Scripts + skill | Full runtime surface | Full daemon surface | Docs only |
| Fits “coding agent product” | Yes as **content** | Yes as **capability pack** | Yes as **sidecar** | Yes as **method pack** |

### 4.3 Recommendation matrix

```text
Target users primarily on Claude Code?
  YES → Ship JS workflows + Skill. Do not reimplement Claude DW.
  NO  →
    Target users primarily on Pi?
      YES → Ship or vendor a Pi dynamic-workflow extension (pi-DW model).
            JS scripts still the user-visible “program”; plugin is the runtime.
      NO  →
        Need CI / multi-IDE / BYO model?
          YES → ODW-shaped thin daemon OR host SDK + same JS dialect subset.
          NO  → Skill + native subagents only (ultracode-style).
```

### 4.4 Preferred packaging for a **greenfield source→wiki coding agent**

**Recommended package shape (host-agnostic product intent):**

```text
repository-wiki-producer/
  skill/                         # L3 method (Agent Skills standard)
    SKILL.md
    references/{plan,generate,refresh,research,review}.md
    templates/...
  workflows/                     # L2 topology (JS, Claude/Pi/ODW dialect)
    wiki-plan.workflow.js        # inventory → research → plan
    wiki-write-review.workflow.js # gated write → review → verify
    wiki-refresh.workflow.js
    wiki-audit-citations.js
  scripts/                       # L0 host (no LLM)
    freeze.mjs
    inventory.mjs
    validate.mjs
    publish.mjs
  agents/                        # optional host-specific agent defs
    researcher.md
    reviewer.md
  adapters/                      # optional
    claude/   → copy workflows into .claude/workflows
    pi/       → thin extension OR depend on pi-dynamic-workflows
    odw/      → register scripts with daemon
```

**Interpretation:**

- **JS is the portable program** users and coding agents author/review.
- **Plugin is optional runtime glue** for hosts that do not already run those primitives (Pi needs extension; Claude Code does not).
- **Do not** make the plugin the method authority (that is Skill).
- **Do not** make the plugin the publish authority (that is scripts).

### 4.5 When to invest in a Pi plugin specifically

**Build/vendor a Pi dynamic-wf plugin if:**

- Primary interactive surface is Pi (or you already standardize on `@earendil-works/pi-*`).
- You need journaled resume, model tiers, worktree isolation, `/workflows` UI.
- You want coding agents to call `workflow` as a tool rather than shell out.

**Do not build a Pi plugin if:**

- Users live in Claude Code / Codex — use their native mechanisms.
- You only need a linear 3-step job (Skill + one agent is enough).
- You would re-implement half of `pi-dynamic-workflows` instead of depending on it.

**Pragmatic path on Pi:**  
*Depend on or fork `pi-dynamic-workflows` for L1; own only wiki Skill + wiki workflow scripts + L0 scripts.*

### 4.6 When plain JS is enough

**Ship JS workflows when:**

- Topology is stable enough to check into git (audit, produce, refresh).
- Coding agent should **edit the workflow** like code (reviewable diffs).
- You want Claude Code users to run `/wiki-plan` and `/wiki-write-review` with no extra daemon.

This matches how community showcases ship value (TradingFlow, stale-docs-audit): **the JS file is the product**.

---

## 5. Source → wiki greenfield design (implementation-agnostic)

### 5.1 Semantic shape (dynamic workflow, not fixed mega-DAG)

```text
freeze (host)
  → inventory (host, deterministic)
  → [optional] parallel research agents → analysis/receipts/*.json
  → mechanical reduce → discovery-map.json
  → plan agent → analysis/spec.json (schema)
  → single writer → candidate/**
  → parallel review lenses → analysis/defects.json
  → bounded repair
  → validate (host) → publish (host)
```

### 5.2 Handoff protocol (mandatory)

| Plane | Content |
|-------|---------|
| **Control** | status, path, digest, ≤N-token summary |
| **Data** | full receipt / pages / defects on disk |
| **Orchestrator context** | args, phase, indexes, budgets — never full transcripts |

### 5.3 What coding agents should receive

1. **Skill** — when/how to produce wiki.  
2. **Workflow JS** — how to fan out/gather without context death.  
3. **Host CLI** — `freeze | validate | publish` for truth gates.  
4. Optionally **one** runtime plugin matching their host (Pi / ODW / none).

---

## 6. Orchestrator context budget

How to keep the **main orchestrator** from blowing its context window or rotting attention when many subagents return results.

**Principle:** The orchestrator must not “remember” child work product. It should hold only **goals, indexes, pointers, and the next decision**. Intermediate results live in **script variables / disk / journal**, not in the main chat history.

Larger context windows do **not** fix this: extra room invites more noise (*context rot*). The scarce resource is **attention quality**, not raw token capacity ([Garg 2026](https://martinfowler.com/articles/orchestrator-tax.html); [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

### 6.1 Who is the “main orchestrator”?

| Shape | Orchestrator is… | Context risk |
|-------|------------------|--------------|
| **A. In-session orchestrator** | Main LLM turn-by-turn `delegate` | **Highest** — easiest to overflow |
| **B. Script / Dynamic Workflow** | JS runtime (~0 tokens for control flow) | Main chat safe; risk moves to **bloated `agent(prompt)`** |
| **C. Host-fixed pipeline** | Application `gather` / DAG | Main session barely participates |

**Prefer B or C.** If stuck on A, apply every rule below more aggressively.

Dynamic Workflow solves *main chat* pollution; it does **not** automatically solve *worker prompt* pollution (see §3.4 anti-patterns).

### 6.2 Layered controls (hard → soft)

#### L0 — Structural isolation (highest leverage)

```text
Main session / script
  ├─ receives only: { path, digest, status, summary ≤ N }
  └─ child agent: isolated session (full tool trail dies with the child)
```

- Children return **summaries by default**, never full transcripts (Claude / Codex / Pi design intent).
- **Never** pull full JSONL/status dumps into the parent for lightweight “how are the agents doing?” checks ([Orchestrator’s Tax](https://martinfowler.com/articles/orchestrator-tax.html)).
- Large outputs: **write file → return path**.

#### L1 — Handoff envelope (mandatory schema)

```json
{
  "status": "ok",
  "path": "analysis/receipts/auth.json",
  "digest": "sha256:…",
  "summary": "at most ~8 bullets / ≤800 tokens",
  "openQuestions": []
}
```

| Rule | Practice |
|------|----------|
| Summary cap | Hard char/token limit + schema validation |
| No nested bulk arrays | Findings live only on disk |
| Failures still envelope | `{ "status": "failed", "path?", "error" }` — not half logs |
| Synthesis prompts | Pass **path lists + task** only; require **JIT `read(path)`** |

#### L2 — Orchestration state outside the LLM

| Store | Holds |
|-------|--------|
| **Script variables** | file lists, phase, result arrays |
| **Disk** | receipts, spec, defects, coverage ledger |
| **Journal / SQLite** | completed callId → resume without re-chat |
| **Main LLM** | user goal, constraints, current phase, indexes, budgets |

Growth of orchestrator-visible state with N children should be roughly **O(index)**, not **O(all evidence text)**.

#### L3 — Compress and clear (when a parent session still grows)

| Technique | Notes |
|-----------|--------|
| Drop old tool results | Re-fetchable from disk when needed |
| Compaction / summarize | **Externalize plan/spec to files first** so compaction cannot erase authority |
| Short standing instructions | High-signal rules only in system / project files |
| Structure-preserving compact | Never `JSON.stringify(x).slice(0, N)`; drop whole elements + record a drop manifest (ODW `context-compact.js`) |

#### L4 — Topology and spawn budget

- Prefer **2–4 agents per wave**; 5+ → merge by cognitive locality first (Garg).
- Parallelize **independent read-only** work only; **single writer** for wiki pages.
- **Multi-wave reduce:** survey → mechanical merge → `discovery-map` → plan (do not synthesize 20 long leaf texts in one shot).
- Children do **not** inherit full parent history; task must be self-contained + skill path references.
- Hard caps: concurrency + `max_agent_calls` (or host equivalent).

### 6.3 Recommended control loop

```text
                ┌─────────────────────────────────┐
                │  Orchestrator (script or thin)  │
                │  Budget: goal + index + limits  │
                └───────────────┬─────────────────┘
                                │ spawn(task, outPath)
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
             worker          worker          worker
            write path      write path      write path
                │               │               │
                └───────────────┼───────────────┘
                                │ envelope only
                                ▼
                ┌─────────────────────────────────┐
                │  Reduce (prefer mechanical)     │
                │  → discovery-map / ledger file  │
                └───────────────┬─────────────────┘
                                │ paths only
                                ▼
                ┌─────────────────────────────────┐
                │  Planner / single writer        │
                │  JIT read needed paths only     │
                └─────────────────────────────────┘
```

### 6.4 Checklist for workflow authors

**Must**

1. Default child outputs to disk; parent stores path lists.  
2. Cap summary size (e.g. 500–1500 tokens); schema-fail → retry.  
3. Forbid paste-all-findings into synthesis prompts; instruct JIT reads.  
4. Use script/host for multi-step control flow — not a long main-LLM state machine.  
5. Observe progress via UI/logs/journal — not by dumping transcripts into the parent.

**Should**

6. End each phase with a checkpoint (phase + path table); drop phase detail from any parent chat.  
7. Prefer mechanical merge for maps; avoid a “super summarizer” that reloads every receipt body.  
8. Route leaves to cheaper/smaller models; keep the main brain sparse.  
9. Enforce concurrency and total agent-call ceilings.  
10. Compact parent sessions occasionally; treat sealed files as authority after compact.

**Must not**

11. `parent.context += child.full_transcript`  
12. `prompt = JSON.stringify(allReceipts)`  
13. Full JSONL fetch for status  
14. Shared unbounded chat history as the only handoff truth  
15. Multi-writer page thrash with all diffs flowing back to the orchestrator  

### 6.5 How each runtime shape controls context

| Implementation | How the main orchestrator stays short |
|----------------|----------------------------------------|
| **Claude DW / pi-DW / ODW** | Script holds intermediates; main chat only sees final `return`. Authors must still bound each `agent()` prompt. |
| **Homegrown `gather` + Agent SDK** | Parent process holds path lists; each phase uses a **fresh short prompt** — do not one-shot the whole fan-out in a single growing session. |
| **Skill-only main session** | Hardest: force packet files + `state.json`; new turns read indexes only. Prefer upgrading to script orchestration. |

**Source → wiki specifics**

- Plan / write: short sessions over **sealed `inputs/`**.  
- Research: entirely in child sessions; root **never** pastes leaf bodies.  
- Review: read `candidate/` + sampled frozen sources; write structured defects — not essay-length chat returns.

### 6.6 Metrics (know when it is working)

| Signal | Healthy | Dangerous |
|--------|---------|-----------|
| Main session input tokens / turn | Slow growth | Linear in N children |
| Single `agent()` prompt size | Low–mid tens of k max, usually less | 50k+ of pasted findings |
| Share of tool dumps in parent | Low (mostly paths) | Large grep/file blobs retained |
| N × average summary size | Bounded by policy | Unbounded |
| Compaction frequency | Occasional | Every step |

Debug logs should report: **parent token estimate**, **path-list length this phase**, **max envelope size**.

### 6.7 Formula

```text
control main context =
  isolate (child sessions)
  + offload (files)
  + cap (schema summaries)
  + externalize control flow (script / host)
  + load just-in-time (read paths)
  + forbid re-injection (no transcript dump)
```

Not: “buy a larger context window.”

### 6.8 Suggested defaults (calibrate per model)

| Parameter | Starting default | Notes |
|-----------|------------------|--------|
| Envelope `summary` | ≤ 800 tokens / ~8 bullets | Fail closed on schema |
| Agents per wave | 2–4 | Merge before 5+ |
| Concurrent agents | host default (often ≤16) | Do not raise without budget |
| Synthesis in-prompt payload | paths + digests only | Bodies via JIT read |
| In-prompt compact budget (if unavoidable) | structure-preserving; e.g. ≤20k chars | Never mid-JSON slice |
| Max agent calls / run | hard ceiling (e.g. 50–200) | Host-enforced |

---

## 7. Explicit non-goals (for this research branch)

- Not proposing migration of current monorepo WikiRuns / Pi product paths.
- Not selecting PydanticAI / LangGraph / Mastra as required.
- Not requiring a web operator cockpit for v1.
- Not multi-writer parallel page authorship.

---

## 8. Suggested follow-ups (future work, not done here)

1. Author paired `wiki-plan.workflow.js` and `wiki-write-review.workflow.js` sketches (Claude-compatible primitives).
2. Spike: install `pi-dynamic-workflows` in a throwaway Pi session and run fan-out-and-synthesize against a fixture repo.  
3. Spike: ODW daemon run of the same script dialect for CI.  
4. If productizing: ADR for “Skill + JS workflow + host scripts” as the portable unit; host adapters as thin.  
5. Codify §6 envelope schema + hard limits in a shared `references/orchestrator-context.md` for the Producer Skill.  
6. Add workflow lint: reject scripts that `JSON.stringify` large arrays into `agent()` prompts (heuristic / AST).

---

## 9. References

### Official / primary

- [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) (2026-05)
- [Claude Code workflows docs](https://code.claude.com/docs/en/workflows)
- [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents)
- [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Garg: The Orchestrator’s Tax](https://martinfowler.com/articles/orchestrator-tax.html) (2026-07)
- [Agent Skills standard](https://agentskills.io)

### Cloned open source

- https://github.com/QuintinShaw/pi-dynamic-workflows  
- https://github.com/Suraj1235/open-dynamic-workflows  
- https://github.com/lxcong/TradingFlow  
- https://github.com/wesammustafa/Claude-Code-Everything-You-Need-to-Know  
- https://github.com/FlorianBruniaux/claude-code-ultimate-guide  
- https://github.com/PabloNAX/ultracode-skill  
- https://github.com/lxcong/awesome-claude-dynamic-workflows  

### Related in-repo notes (historical / product; not binding here)

- `docs/research/claude-code-codex-session-observability-2026-08-01.md`
- `docs/research/current-wiki-workflow-optimization-2026-07-29.md`

---

## 10. Decision record (research-level)

| ID | Decision |
|----|----------|
| R1 | Treat **JS workflow scripts** as the portable orchestration artifact for coding agents. |
| R2 | Treat **Skill** as the sole method layer. |
| R3 | Treat **Pi dynamic-wf as a host plugin**, not the product center — adopt/vendor if Pi is the host; do not reimplement for Claude Code. |
| R4 | Always pair fan-out with **file receipts + short envelopes**; forbid transcript aggregation as Spec/Wiki authority. |
| R5 | Single writer for wiki pages; parallel only for evidence and review lenses. |
| R6 | Host scripts own freeze/validate/publish; no framework required for L0. |
| R7 | Orchestrator context stays **O(index)**: isolate children, offload to files, cap summaries, externalize control flow, JIT-read bodies, never re-inject transcripts. |
