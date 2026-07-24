# Operator Event contract

**Status:** accepted (ADR 0032)

**Date:** 2026-07-24
**Authority:** [ADR 0032](../adr/0032-pi-tool-owned-wiki-runs.md)

## Authority

One `SessionManager`-owned Pi Session is the Operator Session's durable conversation authority. Its real `AgentSession` events are the only live trajectory authority. The Run Boundary owns Wiki Run records and artifacts; the Web module only projects these interfaces.

```text
Web → Server → Agent → Pi
                 ↘ Core
```

Core never imports Pi or Agent. The server never fabricates Pi messages, tool executions, or assistant progress.

## SSE interface

An Operator Session stream sends, in order:

1. one server snapshot containing the current Pi Session projection and linked read-only Run facts;
2. subsequent genuine parent `AgentSession` events without a product-defined business-event layer;
3. heartbeat frames used only to keep the connection alive.

There are no product event injects, event sequence numbers, replay cursors, or in-memory event history. Reconnection starts with a new snapshot. A full Pi message snapshot is authoritative over deltas.

## `wiki_produce`

`wiki_produce` is a real Pi custom tool called by the Operator Agent. Pi owns its `tool_execution_start`, update, and end lifecycle. The same `execute()` call waits for plan and publication decisions. Child sessions remain implementation details: they must not write Operator Session JSONL and must not inject product SSE events. They may only become operator-visible through the parent tool’s structured live `details` (including optional `details.children[]` projections of text/toolCall/usage).

### Live vs durable tool details

Pi persists only the **final** `toolResult` on `message_end` (Operator Session JSONL). Progressive `onUpdate` payloads are not session history.

| Layer | Carrier | Payload | Persisted? |
|---|---|---|---|
| **Live** | `onUpdate` → registry `activeTool` → SSE | Full gate/progress: `status`, `runId`, optional `spec`, `pages`, `children`, `defects` | **No** |
| **Durable** | Final `toolResult.details` | Lean control: `status`, `runId`, short `summary`, optional `pages[]` paths | **Yes** (JSONL) |
| **Run data** | Run Record v2, `analysis/`, `wiki/`, publication path | Full spec, receipts, wiki pages, defects | Run Boundary only |

Do not re-embed complete `WikiRunSpec`, child transcripts, or defect reports into durable `toolResult.details`. After the tool settles, operator UI loads job facts from the Run Record / analysis / Published Wiki APIs, not from historical toolResult mirrors. Live gate UI continues to use `activeTool.details` (including `spec` while awaiting plan).

### Parent/child path-first handoff

In-process child sessions stay on `SessionManager.inMemory` and never write Operator Session JSONL. Research evidence is Host-persisted under `analysis/receipts/{nodeId}.json`. Parent orchestration keeps **relative receipt paths + short summaries** (ADR 0011 control return); full findings are read from disk via `buildReceiptIndex` / path refs. Directory scans are not completion signals.

### Operator history projection

SSE/history snapshots use Pi’s compaction-aware context path (`buildContextEntries` + `sessionEntryToContextMessages`), then product-side strip of fat historical `wiki_produce` details. Pi storage is never rewritten by the snapshot. Live idle handles may be disposed from the process cache; disk JSONL remains until Session delete.

The server may resolve a pending structured gate, but it does not start, resume, or patch a Run through a separate mutable Run route.

## Durability and deletion

- Pi JSONL: durable Operator Session history, discovered and mutated only through `SessionManager`.
- `okf.wiki-run/v2`: linked Run facts and frozen inputs; older schemas are ignored.
- Run work directory: materialized Repository Snapshots, copied Producer Skill, Staging, and analysis artifacts.
- Published Wiki, Workspace, source checkout, and Skill Fork: independent retained data.

Deleting an Operator Session deletes its associated Run records and work directories. It does not delete retained independent data. Old cwd JSONL files and product Session metadata are ignored without migration or automatic cleanup.

## Forbidden parallel paths

- product `source: "product"` SSE events or inject whitelists;
- synthetic Pi messages or tool lifecycle events;
- ring buffers, sequence/replay state, and browser event databases;
- `{sessionId}.json` metadata, filesystem path scans, or merged Session registries;
- `okf.produce_progress` custom entries or duplicate client Produce trees;
- an independent Wiki Run page, mutable Run HTTP routes, CLI, or desktop operator interface.
