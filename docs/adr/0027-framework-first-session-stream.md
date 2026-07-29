# Framework-first Session stream and HITL

**Status:** superseded / historical  
**Date:** 2026-07-22  
**Superseded by:** [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md) (framework is **Pi**, not Mastra / AI SDK); operator surface further refined by [ADR 0031](0031-unidirectional-framework-first-operator-surface.md) and [ADR 0032](0032-pi-tool-owned-wiki-runs.md)  
**Related (historical):** ADR 0020 (Mastra + Web), ADR 0024 (Session conversational workspace), ADR 0025 (wiki workflow + AI SDK bridge), ADR 0026 (Session-centric agent)  
**Historically refined:** [ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) Session stream entry — framework path was the only conversion; product shell was thin  
**Index:** [docs/adr/README.md](README.md)

> **Do not implement as written.** Mastra `suspend`/`resumeStream`, `toAISdkStream`, UIMessage/`useChat`, and `$OKF_WIKI_HOME/mastra` LibSQL snapshots are **not** current product ops. The durable intent is **framework-first Session streaming** (now Pi AgentSession events + JSONL) and a thin product shell — re-read under 0030/0032. **Run** durability and HITL gates are WikiRuns + Run SSE ([0035](0035-durable-wikiruns-control-plane.md)), not Session tool-lifecycle ownership.

## Context

ADR 0025 established a single wiki-run write path and Session streaming via `@mastra/ai-sdk` `toAISdkStream`. Implementation still accumulated product-owned parallel stream semantics (`openWikiWorkflowUiStream` as a second converter story, hand-built gate/progress parts in `session-stream`, dual lifecycle projections). At the time, Mastra and the AI SDK owned workflow HITL, workflow→UI conversion, and chat persistence patterns; product code was not to re-invent those layers. That framework choice is **historical** — product Session transport is now Pi.

## Historical decision (do not implement)

### 1. Stream / HITL / UI parts: Mastra + AI SDK only (historical)

| Concern | Implementation path |
|---|---|
| Workflow HITL | Mastra `suspend` / `resumeStream` + LibSQL snapshots |
| Workflow → UI stream | `@mastra/ai-sdk` `toAISdkStream({ from: "workflow", includeTextStreamParts, sendReasoning })` — same conversion as `handleWorkflowStream` |
| Chat persistence + HTTP stream | AI SDK `UIMessage`, `createUIMessageStream`, `pipeUIMessageStreamToResponse`, `consumeStream`, `useChat` (last-message-only) |
| Progress / custom UI | Workflow step `writer.custom({ type: "data-*" })` (Mastra); not a second HTTP-layer protocol |
| Nested agent visibility | Step-internal `fullStream` → writer + `includeTextStreamParts` / `sendReasoning` |
| Replay / audit (direction) | Prefer `workflowSnapshotToStream` / `getWorkflowRunById` over hand-rolled Run SSE maps |

**Canonical open path for wiki production** is the product thin shell over the **same** steps as `handleWorkflowStream` (`createRun` → `stream` | `resumeStream` → `toAISdkStream`). Full `handleWorkflowStream` is not used as the Session entry because it:

1. wraps output in a nested `createUIMessageStream` (Session already owns outer framing and strips nested `start`/`finish`);
2. does not expose workflow `result()` for product finalize (`mapWorkflowResult`);
3. does not bind product cancel (`bindRunAbortSignal`).

A **minimal fork** of that path is allowed: product abort bind + `closeOnSuspend: true` + raw `toAISdkStream` chunks + `result()` for finalize. **Forbidden:** copying or reimplementing conversion logic; inventing a second Mastra→UI chunk protocol.

### 2. Product shell duties (only where framework is insufficient)

| Layer | Owns | Does not own |
|---|---|---|
| **P1 Session Shell** (agent) | intent/source validation, session lock, assemble start/resume params, product abort bind/unbind, tee framework UI stream into outer Session `createUIMessageStream`, onFinish/drain → P2, optional single redaction filter before persist | Stream conversion semantics; second part protocol; free-text gate parsing |
| **P2 Session–Run transition** (core, pure) | Align product Session status/phase + Run Record with workflow terminal/suspend events | Mastra snapshot internals; UI part invention |
| **P3 Run Boundary** (core) | publish, paths, ignores, validate, stores, skill freeze under boundary | Mastra workflow/agent runtime |

### 3. Destructive API / schema (landed)

- Persist Session history as **AI SDK UIMessage-compatible** `SessionMessage[]` with product **`schemaVersion`** (see ADR 0029 for current value **3**).
- **Reject** on-disk sessions with missing or non-current `schemaVersion` — **no migrate** (v1→v2 was the first wipe cutover; v2→v3 is ADR 0029).
- Structured **`resumeData`** (+ `runId` + `step`) only for gates; no free-text approve/deny inference; no `body.messages[]` legacy.
- Web loads session messages with a thin cast (no local part-rewrite bridge).
- Headless runs share the same shell and force `sessionId` so trajectory lands on the Session timeline.

#### Operator wipe guidance

When loading or listing sessions fails with unsupported `schemaVersion`:

1. Under the workspace root, delete `.okf-wiki/sessions/*.json` (or the specific session file named in the error).
2. Create a **new** Operator Session from the UI (or `POST .../sessions`).
3. Do **not** hand-edit old JSON to set the current `schemaVersion` — message/part contracts are not migrated.

HTTP APIs surface this as **410** with the wipe path in the message. Delete of a legacy session file is still allowed so operators can recover without shell access.

### 4. Ban list

- Self-built `toAISdkStream` business wrappers beyond the **one** thin P1 projection shell (minimal fork of `handleWorkflowStream`’s path).
- Using **Mastra Memory** as the Operator Session entity.
- Dual lifecycle / dual terminal maps for Session vs headless wiki-run (one `mapWorkflowResult` / one transition table).
- Free-text gate inference (`"approve"` in chat, `__choice__:` prefixes).
- **`@mastra/*` inside `@okf-wiki/core`**.
- `handleChatStream` as the wiki production main path (wiki production is **workflow**, ADR 0025).
- Parallel `openWikiWorkflowUiStream` **semantics** as a second converter story (use `openWikiRunUiProjection` only).

## Historical consequences (superseded ops)

- Session and headless opened the same orchestrated Mastra workflow path; only the projection (UIMessage vs job events) differed.
- `session-stream` was expected to shrink toward param assembly + persist hooks without inventing new stream part types at the HTTP/stream layer.
- ADR 0025 streaming clause (`toAISdkStream`) was correct **for the Mastra era**; this ADR pinned **how** the product could call it (framework-first shell only). Both are **superseded by Pi** ([0030](0030-pi-agent-harness-for-semantic-workflow.md)).
- Core stayed free of Mastra; Operator Session remained a product entity (ADR 0026). Core still must not depend on agent frameworks (Mastra or Pi).

## Historical invariants (checklist; map to Pi under 0030)

| Id | Historical invariant | Current reading |
|----|-----------|---|
| F1 | One Mastra→UI conversion: `toAISdkStream` (via thin shell, not a parallel protocol) | One Pi event → UI projection; no dual Session protocol ([0030](0030-pi-agent-harness-for-semantic-workflow.md)/[0032](0032-pi-tool-owned-wiki-runs.md)) |
| F2 | HITL contract = workflow `resumeSchema` / structured `resumeData` | Pi tool-owned gates via real `wiki_produce` lifecycle ([0032](0032-pi-tool-owned-wiki-runs.md)) |
| F3 | Product shell does not reimplement stream conversion | Product shell does not invent a second event author ([0031](0031-unidirectional-framework-first-operator-surface.md)/[0032](0032-pi-tool-owned-wiki-runs.md)) |
| F4 | core has no `@mastra/*` | core has no `@mastra/*` / Pi SDK; Run Boundary only |
| F5 | Session is product-owned; not Mastra Memory | Session is Pi JSONL under product SessionManager; not a second history store |
| F6 | Headless and Session share the same open + terminal map path | Produce path is the real `wiki_produce` tool from the Operator Session |
