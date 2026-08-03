# Linked Browser Operator Session and Run Observation

**Status:** accepted  
**Date:** 2026-08-02  
**Supersedes:** the 2026-08-01 status notes in ADR 0032, ADR 0035, and ADR 0036 that deleted every browser-facing Operator Session surface  
**Retains:** WikiRuns as the sole durable execution control plane, Pi Attempts as disposable Run workers, separate Run SSE and Attempt transcript streams

## Context

The v5 hard cut correctly removed the old Session-owned workflow state. It also
removed the useful conversational entry point: an operator could no longer keep
one conversation and invoke several Wiki generations from it. Reintroducing the
old surface would be wrong because it would make an in-memory Pi turn appear to
own durable scheduling, gates, repairs, or observation.

## Decision

1. The browser exposes a linked Operator Session and Run Workspace at
   `/w/:workspaceId`. `session`, `run`, `stage`, `attempt`, and optional `node`
   are stable URL selections, not alternate workflow state stores. The workbench
   panel is **derived only from the URL** (conversation / run canvas /
   observation) — there is no independent React `surface` store (Epic F).
2. An Operator Session is backed by Pi `SessionManager` history and may invoke
   `wiki_produce` more than once. Each call receives a durable WikiRun receipt
   carrying its `runId`; deleting a Session never deletes its linked WikiRuns.
3. Browser Session SSE begins with a snapshot and then streams a dedicated
   redacted DTO (`@okf-wiki/contract/session`). It includes user-visible text,
   tool lifecycle, and bounded `wiki_produce` receipt details. It excludes
   provider thinking, raw tool arguments/results, system prompts, credentials,
   and filesystem paths. Live chat uses `SessionTranscript`; AgentMessage /
   `AssistantTurn` / `@okf-wiki/contract/stream-server` are not browser paths.
4. WikiRuns remains authoritative for Run state, commands, graph topology,
   gates, repair loops, and durable trace replay. Run SSE and Attempt transcript
   SSE must not be synthesized from Session events. Session and Run connection
   indicators stay separate in the operator chrome.
5. Stopping a Session aborts its current Pi turn only. Stopping, pausing,
   rerunning, approving, or repairing a WikiRun uses its typed Run command and
   retains existing durable semantics across browser/server reconnects.

## Consequences

- One operator can use natural conversation to request multiple independent or
  follow-up generations without losing the durable Run operator surface.
- Session and Run must remain visibly linked by receipts and Run lists, but may
  not overwrite each other's live state.
- Server-side redaction is mandatory because hiding internal fields only in React
  still sends them to the browser.
