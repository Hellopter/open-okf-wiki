# Session as Conversational Workspace

**Status:** partially superseded / historical (AI SDK `useChat` / UIMessage transport) — conversational Session-as-workspace **intent** remains under [ADR 0026](0026-session-centric-agent-workspace.md) and [ADR 0032](0032-pi-tool-owned-wiki-runs.md)  
**Date:** 2026-07-20  
**Related:** ADR 0018 (HITL), ADR 0020 (Mastra + Web), ADR 0023 (stream parts), ADR 0026 (Session-centric agent)  
**Transport superseded by:** [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md) (Pi session + events; not Vercel AI SDK)

> **Do not implement Decision §3–§4 (AI SDK `useChat` / UIMessage stream) as written.** Current operator surface is the **Agent Workspace** projecting Pi JSONL/events ([0030](0030-pi-agent-harness-for-semantic-workflow.md)/[0032](0032-pi-tool-owned-wiki-runs.md)).

## Context

Treating Session as a single Wiki Run request cannot support multi-turn negotiation: plan approval with free-text edits, reject-and-replan, candidate selection, interrupt/resume, or correct streaming UI for model/tool activity.

## Historical decision (transport superseded; intent retained)

1. **Session** is a first-class **Conversational Workspace** (own page), not a Run console alias. **Intent retained** as Agent Workspace `/w/:id`.
2. A Session holds conversation, linked run ids, and runtime stream interrupt/resume within the session thread. Historical shape used ordered UIMessages (`parts`: text, tool-*, data-*); **current** authority is Pi JSONL + real tool lifecycle.
3. **Frontend (historical):** AI SDK `useChat` + `DefaultChatTransport` + message `parts` rendering. **Do not reintroduce** as the product Session path.
4. **Backend (historical):** AI SDK UI message stream (`createUIMessageStream` / `pipeUIMessageStreamToResponse`). **Current:** Pi session SSE / commands via `@okf-wiki/server`.
5. **Approvals and choices** are interaction artifacts on the Session timeline, not a second HITL center. Mutable Run HITL HTTP is removed under [0032](0032-pi-tool-owned-wiki-runs.md).
6. **Wiki Run** remains a bounded production job that may be *started from* a Session; Session history is not the Semantic Workflow **graph** checkpoint for Manual Retry (frozen run inputs still apply). Per [ADR 0026](0026-session-centric-agent-workspace.md)/[0032](0032-pi-tool-owned-wiki-runs.md), the Session **operator timeline must still be durable and complete**.

## Historical consequences (map to Pi)

- Historical route: `/workspaces/:id/session` (chat UI); current operator body is `/w/:id` Agent Workspace.
- Historical persistence under `{workspace}/.okf-wiki/sessions/` (UIMessage JSON) is **not migrated** — Pi sessions live under `.okf-wiki/pi-sessions/` (wipe-not-migrate).
- Fixture mode must still exercise a no-LLM produce path without inventing a second write pipeline.
