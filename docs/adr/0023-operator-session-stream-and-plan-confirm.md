# Operator Session stream parts and plan-confirm gate

**Status:** partially superseded / historical (Session transport and Mastra ops)  
**Date:** 2026-07-19  
**Related:** ADR 0018 (HITL publication), ADR 0020 (Mastra + Web), ADR 0022 (source clone)  
**Superseded (partial) by:** [ADR 0024](0024-session-as-conversational-workspace.md) (Session as conversational workspace), [ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) (historical Mastra/AI SDK stream; single write path intent), [ADR 0026](0026-session-centric-agent-workspace.md) (Session sole operate/observe surface), then **framework transport fully by [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md)** (Pi events) and [ADR 0032](0032-pi-tool-owned-wiki-runs.md) (tool-owned gates)

> **Do not implement Mastra/AI SDK Session transport as written.** Plan-confirm and publication HITL **intent** remain; the live path is Pi `wiki_produce` + Agent Workspace.

## Context

Interactive operators need Claude Code–like visibility of model text, tool use, and subagents during a Wiki Run, without treating the Semantic Workflow as a resumable chat transcript. They also need an optional plan confirmation gate before wiki pages are written.

## Historical decision (transport superseded)

1. **Session UI** provides multi-part operator visibility (Markdown, tool cards, subagent cards, decisions).  
   - **Historical transport (Session, Mastra era):** AI SDK UIMessage stream via `@mastra/ai-sdk` `toAISdkStream` over the wiki-run workflow ([ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)). **Current transport:** Pi AgentSession events / JSONL ([ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md)). Do **not** reintroduce Mastra or hand-rolled dual Session protocols.  
   - **Run console (historical):** product SSE job timeline for headless/job UX must **not** host a second write pipeline ([ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)); independent mutable Run operate surface is removed under [0032](0032-pi-tool-owned-wiki-runs.md).
2. **Wiki Run** remains a bounded job with frozen skill digest; Manual Retry is a new run.
3. **Stream content** stays operator-safe (redaction/truncation; no CoT by default). Concrete part shapes were AI SDK `parts` / product data parts on Session in the Mastra era; now project genuine Pi events.
4. **Plan-confirm** is an optional Workspace flag: when enabled (and not autoApprove), the run enters `awaiting_plan` until the operator approves or declines. Session conversational entry may force plan confirm even when the Workspace flag is off. Implementation is Pi tool-owned gates ([0032](0032-pi-tool-owned-wiki-runs.md)), not Mastra workflow suspend.
5. **Publication HITL** remains after write (`awaiting_publication`). Historical Mastra path used workflow suspend/resume; current path is the real `wiki_produce` tool lifecycle.
6. **Adaptive/Reviewer (historical):** Mastra child agents with research-only tools; Root alone writes wiki Staging. Current supervisor tree is Pi children ([0028](0028-supervisor-tree-and-thin-workflow-shell.md)/[0030](0030-pi-agent-harness-for-semantic-workflow.md)).

## Historical wording (obsolete)

Earlier text said Session was driven by “product SSE projected from Mastra `fullStream`” and that Web “current long runs use SSE + parts.” That described a transitional UI before ADR 0024/0025. Mastra/`useChat` Session is also obsolete under 0030. **Do not implement Session chat that way.**

## Consequences

- Historical Session primary UI: `useChat` + message `parts` ([ADR 0024](0024-session-as-conversational-workspace.md)) — **superseded by Pi Agent Workspace**.
- Headless and autoApprove paths skip plan-confirm and may auto-publish.
- e2e covers fixture timeline, plan-confirm, skill fork, and publish HITL.
