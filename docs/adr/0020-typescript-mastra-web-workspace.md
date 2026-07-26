# Adopt TypeScript, Mastra, local Web UI, and Workspace

**Status:** partially superseded / historical (Mastra/AI SDK framework stack) — TypeScript monorepo, Workspace entity, local Web, and `@okf-wiki/core` Run Boundary remain load-bearing  
**Date:** 2026-07-19  
**Supersedes (partial):** ADR 0006 (Python thin harness); operator-surface clauses of ADR 0016 and ADR 0018 that mandate CLI/TUI as the primary UX.  
**Does not supersede:** ADR 0016’s separation of operator UI from Published Wiki visualization; ADR 0017 portable filesystem publication; product vocabulary in CONTEXT.md except Host→Run Boundary already covered by ADR 0019.  
**Framework stack superseded by:** [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md) (Pi agent harness; no product Mastra / AI SDK)

> **Do not implement Decision §2 (Mastra agents/tools/workflows) as written.** Current Semantic Workflow is Pi in `@okf-wiki/agent` ([0030](0030-pi-agent-harness-for-semantic-workflow.md)–[0033](0033-run-graph-and-agent-layering.md)).

**Later amendments (do not re-litigate from the original Decision text alone):**

| Clause (original) | Now read as |
|---|---|
| Decision §1 Python “transitional” | **Superseded** by [ADR 0021](0021-retire-python-primary-path.md): Python primary path **removed** |
| Decision §2 Mastra Semantic Workflow + path-policy tools | **Superseded** by [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md): Pi harness + built-in tools; further refined by [0032](0032-pi-tool-owned-wiki-runs.md) |
| Decision §6 Git “existing local checkouts only; no remote clone” | **Superseded (partial)** by [ADR 0022](0022-source-clone-into-workspace.md): operator-initiated clone into Workspace is allowed; Semantic Workflow still never clones |
| Operator Session as job-ish surface | Historical Mastra Session path via [0024](0024-session-as-conversational-workspace.md) + [0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md); **current** Session is Pi JSONL / Agent Workspace ([0030](0030-pi-agent-harness-for-semantic-workflow.md)/[0032](0032-pi-tool-owned-wiki-runs.md)) |

## Context

The product was a Python CLI with Pydantic AI, pydantic-ai-harness (CodeMode, SubAgents, DynamicWorkflow, compaction), and a Textual Operator Session TUI. Target constraints for the next generation:

- Primary interactive platform: **Windows**, local single-operator use
- Models: **enterprise OpenAI-compatible** gateways (`base URL` + served model id)
- Operator UI: **local Web** (later embeddable in Tauri or Electron), not a terminal TUI
- Configuration: explicit **Workspace** with local Git sources (link existing checkouts and/or operator-initiated clone — see ADR 0022)

## Decision

1. **Language / runtime:** TypeScript on Node.js LTS. *(Historical: Python `okf_wiki` was transitional; **removed** per ADR 0021.)*
2. **Semantic Workflow (historical):** Mastra agents with discrete path-policy tools (`list_source` / `glob_source` / `search_source` / `read_source` / `write_wiki`), Skills, optional Domain/Leaf/Reviewer subagents, and workflow HITL. **No Code Mode and no agent shell** (ADR 0002). Prefer framework capabilities for agents/workflows/streaming; keep multi-root source policy in product tools. **Superseded:** implement with Pi ([0030](0030-pi-agent-harness-for-semantic-workflow.md)), not Mastra.
3. **Run Boundary:** Product-owned TypeScript package (`@okf-wiki/core`) for snapshot freeze, path policy, mechanical validation, atomic publication, records, local `git` inspection, and secret-safe events. Core must not depend on Mastra, Pi, or React.
4. **Operator surface:** Local Web app (Vite + React + shadcn with **Base UI** primitives) talking to a **127.0.0.1** Node server. Headless `wiki-run` remains for automation. Terminal TUI (Textual/Ink/slash) is not ported.
5. **Workspace:** First-class project entity (name, root path, sources, model ref, publication path, flags). Secrets stay in environment or user-level settings, never in `workspace.json`.
6. **Git sources:** Operators attach sources as **linked absolute checkouts** and/or **operator-initiated clones** into the Workspace ([ADR 0022](0022-source-clone-into-workspace.md)). The product probes local `git` revision/status for Wiki Runs. The Semantic Workflow never clones, fetches, or pushes. Dirty trees default to blocking a Wiki Run. Credentials use the host git helper / SSH agent only—not `workspace.json`.
7. **Source safety:** no agent sandbox shell; multi-root path-policy tools only (source/skill read-only; wiki write only for Root; Effective Source Ignores host-enforced).
8. **Defaults:** Supervisor tree is always on (Domain/Leaf/Reviewer). See [ADR 0028](0028-supervisor-tree-and-thin-workflow-shell.md). Historical `adaptive`/`reviewer` workspace flags are removed.
9. **Desktop shell:** Deferred; same Web UI may later ship inside Tauri (preferred) or Electron without changing the API contract.

## Consequences

- New monorepo packages under `packages/*` (`contract`, `core`, `agent`, `server`, `web`, `skill`; historical `cli` removed).
- ADR 0003/0004/0010/0014/0018 framework-specific wording was revised or superseded in follow-up ADRs as implementations landed.
- Analysis-run temporary storage is renamed in product language to **analysis scratch** to avoid clashing with **Workspace**.
- Wiki Visualization remains a read-only view of Published Wiki content, not a live run console.
- **Historical Mastra write/stream path** lived in [ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) and is **superseded by [0030](0030-pi-agent-harness-for-semantic-workflow.md)/[0032](0032-pi-tool-owned-wiki-runs.md)**. Do not reintroduce dual Staging writers, Mastra workflow suspend as product HITL, or hand-rolled Session stream protocols.
