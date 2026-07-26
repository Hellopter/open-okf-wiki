# Operator Web UX/UI Full Refactor Plan

**Date:** 2026-07-26  
**Scope:** `packages/web` — thorough redesign, **no historical compatibility**  
**Inputs:** full frontend file audit · 2024–2026 agent UI research · shadcn base-nova · Hallmark modern-minimal · domain ADRs (0016, 0026, 0032, 0033)  
**Status:** plan only — not implemented

---

## 0. One-line strategy

> **Build a Linear-style agent session over a Cursor-style plan gate and Pi/assistant-ui nested tool cards, with a Langfuse-style read-only attempt graph on the side — and keep the published wiki as a separate reader product, not a chat artifact.**

Chat is the **control surface**. Wiki is the **product**. Multi-agent work is **nested observation**, not peer chat spam.

---

## 1. Product taste (project-native)

### 1.1 Genre & voice

| Axis | Choice |
|------|--------|
| Genre | **modern-minimal** (Stripe / Linear / Cursor school) — technical, dense, calm |
| Tone | Utilitarian operator console, not marketing SaaS, not dark-AI atmospheric theater |
| Primary object | **Workspace** |
| Primary mode | **Operate** (Operator Session) |
| Secondary modes | **Read** (Published Wiki) · **Configure** |
| Typography | Keep Geist (preset); mono for paths, node keys, run ids only |
| Color | Semantic tokens only (`bg-background`, `text-muted-foreground`, `destructive`, `success`) — no raw blues/emeralds |
| Motion | Motion-cut: spinner + collapsible + phase playhead only; no confetti, no bounce |

### 1.2 What makes this UI *ours* (not generic chat)

1. **Wiki-shaped progress** — pages planned / written / reviewed / blocked, not “step 14 finished”.
2. **Source-grounded language** — citations, snapshot set, receipts, defects — visible in operate and read modes.
3. **Dynamic workflow legibility** — phase strip + read-only run graph + attempt tree (ADR 0033).
4. **`wiki_produce` is the hero tool** — plan/publication gates are first-class surfaces, not nested `pre` crumbs.
5. **One transcript truth** — Pi session projection only (ADR 0032); no dual event authors.
6. **Operator ≠ Reader** (ADR 0016) — never ship wiki chrome inside chat bubbles.

### 1.3 Hallmark / anti-slop constraints

- No multi-sidebar chrome soup (the current tell).
- No invented metrics / fake “AI magic” empty states.
- No redrawn IDE chrome or fake browser bars.
- Structural variety where it matters: **Operate workbench ≠ Wiki long-document ≠ Configure form wall**.
- Prefer shadcn composition over hand-rolled `.subnav` / `.page-header` / `.muted` utility era.

---

## 2. Diagnosis summary (current state)

### 2.1 Architecture today

```
Layout + AppSidebar (always)
  └── WorkspaceShell (+ WorkspaceSubnav peer tabs)
        └── AgentWorkspaceShell (sessions | transcript | context)
              └── ToolExecutionCard → WikiProduceGatePanel → RunGraph (nested, tiny)
```

Routes split `/w/:id` vs `/workspaces/:id/*`; `rootPath` query threaded everywhere.

### 2.2 P0 problems (must kill in refactor)

| # | Problem | Evidence |
|---|---------|----------|
| 1 | **Chrome soup** — 3–5 concurrent nav systems on agent page | AppSidebar + immersive header + Subnav + agent panes + mobile headers |
| 2 | **Dual URL namespaces** + `rootPath` ritual | `App.tsx`, `workspace-path.ts` |
| 3 | **`wiki_produce` / gates unusable** — nested in tool expand, 10px mono wall | `WikiProduceGatePanel.tsx` |
| 4 | **Run graph is not a graph** — edges computed, never drawn; chip grid only | `view-model.ts` + `RunGraphCanvas.tsx` |
| 5 | **`read` tools header-only** — content never expandable | `tool-display/summary.ts` |
| 6 | **Tool I/O is raw `<pre>`** — no code surface, no md | `ToolExecutionCard.tsx` |
| 7 | **Context panels dead weight** — static lists, no live run binding | `ContextPanels.tsx` |
| 8 | **IA: Agent/Sources/Wiki/Settings as equal peers** | `WorkspaceSubnav.tsx` |

### 2.3 What already works (keep / deepen)

- shadcn chat primitives: `MessageScroller` / `Message` / `Bubble` / `Marker` / `Empty`
- Streamdown stack for assistant + wiki markdown (code / math / mermaid / cjk)
- OpenCode-style tool **header** (title + path + chips) — directionally correct
- Pi event projection architecture (do not re-architect server for UI vanity)
- i18n en/zh scaffold
- base-nova + Geist + semantic tokens

### 2.4 shadcn inventory gap

**Installed & used well:** button, card, dialog, sheet, sidebar, tabs, field, table, chat set, collapsible, badge, empty, sonner, spinner, scroll-area, command, …

**Missing for target UX (add via CLI):**

- `resizable` — pane split instead of fixed `w-52`/`w-60`
- `progress` — phase / page write progress
- `accordion` — settings sections, attempt groups
- `hover-card` — path previews, node summaries
- optional later: `dropdown-menu`, `pagination`, `toggle-group` for phase filters

**Do not** reintroduce AI Elements as a second design system if shadcn chat + domain cards cover it; **port interaction patterns only**.

---

## 3. Lessons from 2024–2026 agent UIs (actionable)

| Source | Steal | Reject |
|--------|-------|--------|
| AI SDK / AI Elements | parts lifecycle; Tool / Reasoning / Sources progressive disclosure | Second stream protocol beside Pi projection |
| assistant-ui | nested subagent = tool trail; ToolGroup collapse | Peer multi-agent bubbles in parent scroller |
| CopilotKit / AG-UI | soft vs hard HITL; events → view model | Open HTML generative UI |
| Cursor / Claude Code / Cline | Plan mode as durable artifact; risk-tiered tools; diffs for writes | YOLO publish; plan only as chat prose |
| Devin / Linear Agents | session over work object; structured activities; dual surface | Fake typing; product outcome only in chat |
| Langfuse / LangSmith | aggregated graph default + expand loops; tree vs log dual view | Spans as default operator chrome |
| Dify / Langflow / Flowise | playback highlight / playhead | **Builder canvas as operator home** |
| Open WebUI / LibreChat | artifacts side pane layout idea | Marketplace / multi-model beauty contest |
| Notion AI | citations + source scope | Treating wiki as chat artifact |
| shadcn MessageScroller | user-anchor, live-edge follow, jump-to-latest | Forced scroll during plan review |

Full memo synthesis lives in the research pass that produced §4 principles below.

---

## 4. Design principles (OKF-specific)

1. **Wiki is the product; chat is the control surface.**
2. **One operator timeline; nested work** — not parallel chats.
3. **Event projection is the UI architecture** — browser reduces events; never holds AgentSession.
4. **Specialize tool chrome by risk & product meaning.**
5. **Plan-confirm is a mode**, not a message flavor (Cursor Plan).
6. **Dynamic workflow = phases + attempts** (aggregated default).
7. **HITL has two intensities** — soft conversational / hard sticky gate.
8. **Separate Operator mode from Reader mode** (ADR 0016).
9. **Source grounding is first-class visual language.**
10. **Prefer shadcn composition over custom chrome.**
11. **Scroll & attention rules** for long runs; sticky hard gates.
12. **Progress copy uses domain vocabulary** (Staging Wiki, defect, attempt, Snapshot Set).
13. **Observability is layered** L0 operator / L1 debug / L2 developer traces.
14. **Durable session, frozen run** — retry = new run (ADR 0012).
15. **Controlled generative UI only** — typed domain components, never model HTML.

---

## 5. Target information architecture

### 5.1 Route map (break dual namespace)

```
/                              → /workspaces
/workspaces                    → workspace list (app shell)
/settings                      → global models / doctor (app shell)

/w/:workspaceId                → Operate (default) — immersive workbench
/w/:workspaceId/wiki/*         → Reader — full-bleed wiki
/w/:workspaceId/configure      → Configure — sources + skill + danger (tabs/accordion)

# removed:
# /workspaces/:id/sources|wiki|settings
# rootPath query (server resolves by workspaceId; optional internal hint only if needed)
```

**Compat:** none. Update e2e, deep links, docs in the same cut.

### 5.2 Shell model (2 shells, not 4)

#### Shell A — App shell (list & global)

- Thin top bar or icon rail: brand · workspaces · settings · locale · theme · ⌘K
- Content: workspaces table, global settings
- **No** permanent dual-sidebar tax

#### Shell B — Workspace workbench (operate / configure)

```
┌─ Top bar (single) ─────────────────────────────────────────────────────┐
│ ← Workspaces · Workspace name · [Operate | Wiki | Configure] · status  │
│   phase strip when run active · ⌘K · theme/locale                      │
├─ Sessions ─┬─ Transcript + Composer ──────────┬─ Run / Context ────────┤
│  list      │  MessageScroller                 │  contextual, not dead  │
│  new/del   │  tools / thinking / gates        │  tabs by mode          │
│            │  sticky HITL when awaiting       │                        │
└────────────┴──────────────────────────────────┴────────────────────────┘
```

#### Shell C — Wiki reader (separate layout)

```
┌─ Thin bar: back to Operate · page search · language badge ─────────────┐
├─ TOC tree ─┬─ Article (Streamdown, long-document rhythm) ──────────────┤
│  hierarchy │  title · citations · mermaid · prev/next                  │
└────────────┴───────────────────────────────────────────────────────────┘
```

**Kill permanently:**

- Peer `WorkspaceSubnav` equal tabs as primary chrome
- AppSidebar always-on during Operate (replace with top bar / icon rail)
- Immersive slash-path header + mobile agent header stacking
- Right pane permanent “Sources / Runs / Wiki” stubs that only link out

---

## 6. Surface redesign by product area

### 6.1 Operate — Transcript (center)

**Keep:** MessageScroller, Message, Bubble, Marker, Empty, AgentMarkdown (Streamdown).

**Change:**

| Item | Target |
|------|--------|
| Thinking | Collapsible “Reasoning”; mono pre OK when short; collapse when settled |
| System / tool system rows | Use `Marker` consistently; kill centered plain `<p>` |
| Parts path | Prefer `parts[]` ordering (thinking → text → tools) as sole layout path |
| Waiting empty | Distinct copy: “Waiting for events…” vs “Thinking…” (never conflate) |
| Hard gate | When status `awaiting_*`, **sticky composer bar** + jump-to-gate; gate card remains in transcript as durable artifact |
| Max width | Keep ~42rem for prose; tool cards may go full pane width |

### 6.2 Operate — Tools (inline)

**Architecture:** specialized renderers registry.

```
ToolExecutionCard
├── header: status · icon · title · subtitle · arg chips   (always)
└── body (expand when useful):
    ├── read / grep / ls  → ScrollArea + syntax-highlighted code (Streamdown code or Shiki)
    ├── write / edit      → path + diff-ish preview (unified lines) + result line
    ├── bash / shell      → $ command + output pre (terminal density)
    ├── wiki_produce      → WikiRunCard (hero) — see 6.3
    └── unknown          → collapsible pretty JSON fallback
```

**Rules:**

- **Never** `headerOnly` for `read` when `output` exists.
- Expand body is **result-only** (no re-dump of header args) — keep OpenCode discipline.
- Default collapsed when `done` and settled; open when running / error / awaiting.
- Subagent / children: nested collapsible trail under parent tool (`details.children`), **not** peer assistant messages (ADR 0032 + assistant-ui pattern).

### 6.3 Operate — Wiki Run cockpit (first-class)

**Promote out of nested 10px mono.**

When `wiki_produce` is active or selected:

1. **In transcript:** compact hero tool card  
   - Phase badge · pages written/total · gate state · one-line summary  
   - Click “Open run” → focuses right pane
2. **Right pane (Run tab auto-selected):** full **Run Cockpit**
   - **Phase strip** (Progress + Badge): freezing → planning → awaiting_plan → producing → awaiting_publication → terminal
   - **Plan document card** (when plan present): audience, domains, page checklist, open questions — Approve / Request changes / Reject (hard HITL)
   - **Run graph** (read-only): layered nodes **with edges or clear parent hierarchy**; playhead; aggregated by default; expand retries
   - **Attempt inspector**: selected node → summary, status, item list, errors; markdown for text items
   - **Publication gate** card when awaiting
   - **Defects / receipts** summary (product vocabulary)

**Do not** stack Canvas + Timeline + Inspector + full attempt list all expanded at once (current quadruple). Default: phase strip + graph; inspector on selection; timeline as optional Accordion “Attempt log”.

### 6.4 Operate — Run graph visual language

| Mode | Visual |
|------|--------|
| Default | Horizontal or vertical **phase lanes** with nodes as Badge/Card chips; **SVG/CSS edges** between dependencies (use existing `vm.edges`) |
| Playhead | Highlight current `nodeKey`; subtle pulse only on `running`/`awaiting` |
| Aggregated | Collapse multi-attempt nodes to `×N` with latest status |
| Expanded | Click node → attempt list in inspector (not a second full graph) |
| Empty | Honest Empty component: “No run graph until wiki_produce starts” |

**Not in scope:** free-form React Flow builder, port editing, palette.

Optional dep: only if pure CSS edges fail readability; prefer zero new graph libraries first.

### 6.5 Operate — Sessions (left)

- Session list with status chips (idle / running / awaiting / error)
- Create / delete always visible (no hover-only opacity-0)
- Optional: last activity time, linked run badge
- `ResizablePanel` width; collapse to rail with icon
- Mobile: Sheet (keep pattern)

### 6.6 Operate — Context right pane (alive)

Tabs driven by **context**, not static stubs:

| Tab | Content |
|-----|---------|
| **Run** | Cockpit (default when produce active) |
| **Pages** | Staging / planned page list from live run or recent run; open reader |
| **Sources** | Snapshot set summary (id, rev, path); link to Configure |
| **Debug** | L1: raw tool dump toggle, session id, run id (collapsed by default) |

Kill permanent “Open” stubs that only deep-link without data.

### 6.7 Wiki reader

- Full-bleed reading layout (Long Document rhythm)
- Hierarchical TOC tree (path segments), not flat path list in a Card
- Shared `MarkdownDocument` module (one Streamdown plugin config)
- Citation chips → hover/sheet with source path (jump later if API allows)
- No admin Card chrome around the article
- Empty: Empty + CTA “Back to Operate to produce”

### 6.8 Configure

Single route with Accordion or Tabs:

1. Sources (merge current Sources page — progressive disclosure: list first, add via Dialog/Sheet)
2. Models / roles (workspace orchestration)
3. Skill fork editor (file tree + editor; not bare underline “list root”)
4. Danger zone (delete workspace)

### 6.9 Workspaces list

- Richer rows: last session activity, last run status, wiki page count if known
- Create workspace: reduce absolute-path anxiety with clearer FieldDescription + folder picker if available later
- Empty state with single primary CTA

### 6.10 Global settings

- Keep models + doctor
- Model editor in **Sheet/Dialog**, not layout-jumping inline mega-card
- Visible theme control in chrome (not only ⌘K / `d` key)

### 6.11 Command palette (⌘K)

Power operator surface:

- Navigate: workspaces, current sessions, wiki pages, configure sections
- Actions: new session, stop agent, open run cockpit, toggle theme/locale
- Not a 2-item stub

---

## 7. Component architecture (shadcn-first)

### 7.1 Add from registry

```bash
cd packages/web
pnpm dlx shadcn@latest add resizable progress accordion hover-card
# evaluate: dropdown-menu toggle-group
```

### 7.2 Domain components (new tree)

```
packages/web/src/
  app-shell/           # AppShell, TopBar, WorkspacesPage
  workbench/           # WorkbenchShell, SessionRail, Composer, Transcript
  tools/               # ToolExecutionCard + specialized bodies
  run/                 # PhaseStrip, PlanGateCard, RunGraph, AttemptInspector, WikiRunCard
  wiki-reader/         # WikiReaderShell, TocTree, MarkdownDocument
  configure/           # ConfigurePage sections
  shared/              # ConfirmDialog, ErrorBanner, CommandMenu, MarkdownDocument core
  components/ui/       # shadcn only
```

**Delete / absorb after migration:**

- `WorkspaceSubnav.tsx` (IA replaced)
- Dual headers in `WorkspaceShell` immersive path (replaced by Workbench top bar)
- Parallel CSS: `.page-header`, `.subnav`, `.muted`, `.form`, `.kv`, `run-page` dead rules
- Duplicate Streamdown setup files → single `MarkdownDocument`

### 7.3 Shared markdown

```tsx
// shared/MarkdownDocument.tsx
// one plugins object; mode: streaming | static; surface: agent | wiki
```

CSS: single class family `.okf-md` (drop triple wiki/session/agent selector duplication).

### 7.4 Styling rules (shadcn skill)

- `className` for layout only; variants for chrome
- `flex` + `gap-*` (no `space-y-*`)
- `size-*` for equal dimensions
- Semantic colors only
- Icons: `data-icon` in buttons; no ad-hoc `size-4` inside Button
- Forms: `FieldGroup` + `Field` only
- Empty → `Empty`; toast → `sonner`; loading → `Skeleton`/`Spinner`
- Kill `text-[10px]` mono walls as default density; use `text-xs` / `text-sm` with intentional mono for ids

---

## 8. Data / projection notes (UI-facing, no compat)

| Topic | Decision |
|-------|----------|
| Workspace routing | Id-only URLs; server resolves rootPath from store |
| Live runs in cockpit | Subscribe/poll run record + `wiki_produce` tool details; boot-once list is insufficient |
| Graph edges | Render `vm.edges`; if snapshot lacks edges, derive parent edges from attempt tree |
| Gate history | Persist enough gate/plan snapshot in tool result or run record so history isn’t live-only cliff |
| Subagent disclosure | Only via `details.children` / attempt items — no product inject |
| E2E | Rewrite selectors around new shells; drop dual-route helpers |

Server/agent contract changes only if required for:

- durable plan document on historical tools
- workspaceId-only resolution
- richer page-progress fields on produce details

Prefer projecting existing fields first; expand contract in a separate ADR if needed.

---

## 9. Implementation phases

### Phase 0 — Foundations (1 cut)

- [ ] Lock design tokens in `index.css` (trim legacy utilities)
- [ ] Add shadcn: resizable, progress, accordion, hover-card
- [ ] Extract `MarkdownDocument` + unify CSS
- [ ] Route map rewrite (`App.tsx`, path helpers, e2e helpers)
- [ ] AppShell + WorkbenchShell skeletons (empty content OK)

**Exit:** app boots, routes resolve, no dual `/workspaces/:id` paths.

### Phase 1 — Operate chrome & IA

- [ ] Single top bar; kill AppSidebar-on-operate + WorkspaceSubnav
- [ ] Resizable 3-pane workbench
- [ ] Session list a11y fix + status badges
- [ ] Command palette v1 (nav + theme)
- [ ] Composer sticky HITL slot

**Exit:** one navigation system; full-height transcript on laptop.

### Phase 2 — Tools & transcript quality

- [ ] Tool renderer registry
- [ ] Fix `read` expand + code body
- [ ] write/edit preview; bash density
- [ ] Nested children trail
- [ ] Marker/system cleanup; waiting copy

**Exit:** research tools legible; no header-only read.

### Phase 3 — Run cockpit & graph

- [ ] WikiRunCard in transcript
- [ ] Right-pane Run cockpit
- [ ] Phase strip + PlanGateCard + PublicationGateCard
- [ ] RunGraph with edges + playhead + selection → inspector
- [ ] Collapse Timeline into Accordion log
- [ ] Live binding of recent/active run

**Exit:** can approve plan / watch phases without expanding a nested tool pre.

### Phase 4 — Wiki reader + Configure

- [ ] Full-bleed reader + TOC tree
- [ ] Citation hover affordances
- [ ] Merge Sources + WorkspaceSettings into Configure
- [ ] Progressive disclosure forms (Sheet/Dialog)

**Exit:** reader feels like a book; configure is one place.

### Phase 5 — Polish & density

- [ ] Workspaces list richness
- [ ] Global settings Sheet editor
- [ ] i18n hardcode sweep (Stop, Open, ErrorBoundary, …)
- [ ] Theme control in chrome
- [ ] a11y pass (focus, live regions, hover-only controls)
- [ ] Delete dead CSS/i18n (`runStatus` leftovers, `run-page`)
- [ ] E2E green on new selectors

**Exit:** shippable taste; no half-migrated chrome.

---

## 10. Explicit non-goals

- Historical route redirects / dual URL support
- Dify-style workflow builder for operators
- Embedding full published wiki HTML inside chat
- Browser-side AgentSession / second event protocol
- AI Elements as parallel component library (patterns only)
- Marketing landing redesign
- Pixel clone of Cursor/Devin/Linear

---

## 11. Success criteria

| Signal | Measure |
|--------|---------|
| Chrome | ≤ 1 primary nav system per mode |
| Produce UX | Plan/publication gates reachable without hunting tool expand |
| Tools | `read` shows content; code highlighted |
| Graph | Edges or hierarchy visible; playhead tracks active node |
| Wiki | Reader full-bleed; Streamdown quality preserved |
| Density | Transcript usable at 1280px width with side panes open |
| Stack | Domain UI built from shadcn primitives; no new ad-hoc design system |
| Domain | Progress copy uses Wiki/Run/defect vocabulary |

---

## 12. Suggested first implementation PR sequence

1. **PR-A:** routes + shells skeleton + MarkdownDocument extract  
2. **PR-B:** workbench chrome (kill subnav/sidebar soup) + resizable panes  
3. **PR-C:** tool registry + read/write renderers  
4. **PR-D:** run cockpit + graph edges  
5. **PR-E:** wiki reader + configure merge  
6. **PR-F:** polish, i18n, e2e, dead code purge  

Each PR must keep typecheck + targeted e2e green; full e2e rewritten by PR-F.

---

## 13. Open decisions (confirm before Phase 0 code)

1. **Workspace id-only URLs** — confirm server can always resolve rootPath from id (drop query).  
2. **Graph rendering** — pure CSS/SVG first vs allow one lightweight edge library.  
3. **Configure vs Sources** — single `/configure` with sections (recommended) vs keep Sources as sub-route under `/w/:id/configure/sources`.  
4. **Theme default** — system vs dark-first for operator density.  
5. **Plan edit** — approve-only first, or inline edit of page list in PlanGateCard (Cursor-like). Recommend: approve + free-text “request changes” first; structured edit later.

---

## Appendix A — File kill list (target)

| File / pattern | Fate |
|----------------|------|
| `WorkspaceSubnav.tsx` | Delete after Workbench top nav |
| Dual immersive header branch in `WorkspaceShell` | Replace with WorkbenchShell |
| `ContextPanels.tsx` static tabs | Replace with Run/Pages/Sources/Debug cockpit |
| `summary.ts` `headerOnly: read` | Remove |
| Duplicate Streamdown plugin blocks | Single module |
| `index.css` `.page-header` `.subnav` `.muted` `.form` `.kv` `run-page` | Delete or absorb |
| `/workspaces/:id/*` routes | Delete |
| e2e helpers for dual paths | Rewrite |

## Appendix B — Reference bookmarks

- Internal: `docs/research/agent-ui-event-projection.md`, `docs/research/pi-ui-design-vs-okf-workspace-2026-07.md`
- ADRs: 0016, 0012, 0026, 0032, 0033
- External: AI Elements Tool/Reasoning/Sources · assistant-ui multi-agent · Cursor Plan Mode · Langfuse agent graphs · Linear agent interaction · shadcn MessageScroller · Cline risk-tier tools

---

*End of plan.*
