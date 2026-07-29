# Let a real Pi tool own each Wiki Run

**Status:** accepted (whole-Run ownership superseded — see status note)  
**Date:** 2026-07-24  
**Refines:** ADR 0030 and ADR 0031  
**Supersedes:** ADR 0030's WikiRunShell clauses, ADR 0031's product-inject stream, and the session side-metadata design  
**Superseded in part by:** [ADR 0035](0035-durable-wikiruns-control-plane.md)

> **Status note / Superseded clauses (read first)**  
> [ADR 0035](0035-durable-wikiruns-control-plane.md) **supersedes whole-Run Pi-tool ownership** and the prohibition on durable Run commands/events:
>
> - ~~`wiki_produce` tool execution owns planning, production, review, and plan/publication waits~~ → **Historical.**  
> - **Current:** `wiki_produce` / `wiki_repair` are **thin adapters**: dispatch WikiRuns commands (`StartRun` / `RerunNode`, …) and return a **receipt**. They do **not** await the Run or own gates.  
> - Durable Run lifecycle, typed gates, attempts, artifacts, and **Run SSE** live in WikiRuns (`okf.wiki-runs/v1`).  
> - **Retained from this ADR:** Pi-only Operator Session conversation events; `SessionManager` authority for conversations; one Agent Workspace; no product-inject stream / session metadata / reconstructed tool lifecycle; thin tool surface over WikiRuns (not a second Session-owned state machine).

The Agent Workspace is the only operator interface. An Operator Agent starts a Wiki Run by calling the real Pi custom tool `wiki_produce`; ~~that single tool execution owns planning, production, review, and the plan/publication waits~~ (**historical** — under 0035 the tool returns a **StartRun receipt** and WikiRuns owns the durable job). Pi therefore writes the **tool call/result** to its own Session, while the Run Boundary owns immutable inputs, Staging, validation, publication, and sealed Artifacts; WikiRuns owns durable control. In-process plan/domain/leaf/reviewer children stay off the Operator Session transcript; progressive disclosure of attempt work is parent-visible framework shape and/or Run SSE — not a second conversation body channel.

`SessionManager` is the sole **Session** authority. Operator Session SSE begins with a current server snapshot, then forwards only genuine Pi events and heartbeat frames; there is no product event injection, sequence/replay protocol, ring buffer, session metadata file, or reconstructed tool lifecycle. **Run SSE is separate** (ADR 0035). Deleting a Session deletes conversation data; it does not delete WikiRuns control records or audit Artifacts (0035). Published Wiki, Workspace, source checkout, and Skill Fork are retained.

Repository Snapshots are materialized from exact Git revisions into run-owned ordinary file trees. Effective Source Ignores are removed during materialization, Git symlinks remain inert text, and the copied Producer Skill digest is verified before execution. Old Session metadata, cwd JSONL files, and pre-v2 Run Records are ignored without migration or automatic deletion.

The retained product packages are `contract`, `core`, `agent`, `server`, `web`, `skill`, and the WikiRuns control implementation (`workflow` / server ownership per 0035). The CLI, desktop placeholder, independent Run page, WikiRunShell, and compatibility adapters are removed because each duplicated an existing product interface or authority. Durable mutable Run **command/SSE** routes are allowed only as WikiRuns adapters (0035), not as a Session-owned second state machine.

**Reviewer model resolution (fail-closed):** When the Semantic Workflow resolves per-role models, an empty `roleModels.reviewers` list falls back to the Workspace default model (single-reviewer council). If resolving the reviewer model **throws** (missing profile, credentials, catalog failure), the run must **not** silently substitute the writer model. Production fail-closes with a blocking `reviewer_missing` defect (or equivalent failed status). Planner/worker may still tolerate fallback to writer for economics; reviewer does not.
