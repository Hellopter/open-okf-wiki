# Mastra Wiki Workflow and official AI SDK bridge

**Status:** superseded / historical  
**Date:** 2026-07-20  
**Superseded by:** [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md) (Pi harness; no Mastra / AI SDK product path); Session/Run execution further refined by [ADR 0032](0032-pi-tool-owned-wiki-runs.md)  
**Related (historical):** ADR 0020 (Mastra + Web), ADR 0023 (stream parts), ADR 0024 (Session as conversational workspace), ADR 0026 (Session-centric agent), ADR 0027 (framework-first stream/HITL under Mastra)  
**Index:** [docs/adr/README.md](README.md)

> **Do not implement as written.** Framework clauses (Mastra wiki-run workflow, `runWikiAgent`, `toAISdkStream`, Mastra libSQL under `$OKF_WIKI_HOME/mastra`) are **not** the product path. Current stack: Pi + `packages/*` ([0030](0030-pi-agent-harness-for-semantic-workflow.md)–[0033](0033-run-graph-and-agent-layering.md), [0021](0021-retire-python-primary-path.md)). The durable intent that remains is **one Staging write path** and **Session as the operator timeline** — re-read under 0030/0032.

## Context

The TypeScript product briefly had two Staging production paths (Session template materialize vs Mastra `runWikiAgent`) and two stream protocols (hand-rolled `WikiStreamPart` → SSE vs AI SDK UIMessage). Session HITL used string prefixes (`__choice__:`) instead of framework resume.

## Historical decision (do not implement)

1. **Single production path:** Mastra **wiki-run workflow** (`wikiRunWorkflow`) owned plan → write → publish gates. Write went through `runWikiAgent` tools (fixture or live). Session and Run console were entrypoints, not alternate writers.
2. **HITL:** Plan and publication used workflow **suspend/resume**. Product REST approve/deny endpoints **resumed** the same workflow run id. Session sent explicit `{ intent, runId, step, resumeData }` via AI SDK transport (no `__choice__:` protocol, no text `"approve"` inference). Gate UI was projected as product **`data-gate`** (+ **`data-plan`**) parts—not fake `tool-request_user_decision` / `data-choice`.
3. **Streaming:** Session UI used `@mastra/ai-sdk` **`toAISdkStream`** over workflow `stream` / `resumeStream` (or equivalent projection into the same UIMessage timeline). Prefer the framework path aligned with `handleWorkflowStream` (or a documented minimal fork when product needed `result()` / abort / no nested `createUIMessageStream`) — see [ADR 0027](0027-framework-first-session-stream.md). Do not reintroduce hand-written Mastra chunk → product SSE projection for Session, and do not maintain a parallel product converter with different semantics. **Single write path does not excuse an empty Session timeline** — agent/workflow activity must still project operator-useful parts into the Session ([ADR 0026](0026-session-centric-agent-workspace.md)).
4. **Run Boundary** stayed in `@okf-wiki/core` (path containment, validate, atomic publish, run/session records). Core must not depend on Mastra.
5. **Path policy** primitives (`isPathInside`, `resolveContainedPath`, `assertContainedPathSafe`) lived in core; agent re-exported for tools.
6. **Web types** imported domain shapes from `@okf-wiki/contract`; `api.ts` was HTTP transport only.
7. **Fixture mode** was an adapter on the same workflow/agent seam (`OKF_WIKI_AGENT_MODE=fixture`), not a Session-only materialize path.

## Historical consequences (superseded ops)

- Session forced plan confirm (`forcePlanConfirm`) for conversational negotiation even when workspace `planConfirm` was false for headless Run starts.
- **Retired ops:** Mastra libSQL storage under `$OKF_WIKI_HOME/mastra` (or `~/.okf-wiki/mastra`) and `OKF_WIKI_MASTRA_STORAGE` were used for Mastra workflow suspend snapshots. They are **not** current product configuration — do not create or document `~/.okf-wiki/mastra` as live storage. Pi sessions and Run Record v2 replace that durability story ([0030](0030-pi-agent-harness-for-semantic-workflow.md), [0032](0032-pi-tool-owned-wiki-runs.md)).
- Dead parallel DTOs (`WikiRunRequest` / outcome kinds unused by the live path) were removed; frozen inputs lived on `StoredRunRecord`.
- ADR 0023’s product SSE for the Run console may have remained for job timeline UX, but must not host a second write pipeline.
