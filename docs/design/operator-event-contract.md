# Operator Event contract

**Status:** accepted (ADR 0035)  
**Date:** 2026-07-29  
**Authority:** [ADR 0035](../adr/0035-durable-wikiruns-control-plane.md)  
**Supersedes:** ADR 0032-era Session-owned wiki_produce HITL and fat live tool details

## Authority

```text
Operator Session (Pi SessionManager JSONL)
  → conversation only: prompts, tool receipts, assistant text

WikiRuns (workflow.sqlite + sealed artifacts)
  → Run control: nodes, attempts, gates, effects, Run SSE
```

- **Session SSE** projects genuine Pi conversation events (and StartRun receipts on `wiki_produce`).
- **Run SSE** (`GET …/runs/:runId/events`) is the durable control projection: full secret-free snapshots.
- Web never invents control state from Session mirrors. Live plan/publication HITL uses **ResolveGate** on the Run command API.

## `wiki_produce`

`wiki_produce` is a Pi custom tool. Its `execute()` **dispatches `StartRun` and returns immediately** with a receipt:

```json
{ "status": "accepted", "runId": "…", "summary": "…" }
```

It does **not** wait for plan or publication. Live Run status, open gates, graph chips, and failed-node actions come from `useWikiRun` (GET snapshot + Run SSE).

### Tool details (receipt only)

| Field | Role |
|-------|------|
| `status` | `accepted` / `failed` / `cancelled` (StartRun outcome) |
| `runId` | Durable WikiRuns id |
| `summary` | Short operator text |
| `pages` | Historical only; current path does not write pages on the receipt |

Do **not** re-embed `spec`, `graph`, `defects`, or `children` on tool details. Spec review loads `GET …/runs/:runId/spec` (sealed artifact). Graph labels come from WikiRunSnapshot node projection (`label`, `parentKey`, `detail`).

### Gates

| Concern | Mechanism |
|---------|-----------|
| Open plan / publication gate | WikiRuns control plane (`waiting_for_operator`) |
| Operator decision | `POST …/runs/command` → `resolve_gate` with `payloadDigest` CAS |
| Plan body for review | Sealed Spec artifact + `GET …/runs/:runId/spec` → `SpecReviewView` |
| Session `pendingGate` / `resume_gate` | **Removed** (hard-cut) |

`workspace.planConfirm === false` auto-materializes Definition v1 after plan without opening a plan gate.

## Streams

### Operator Session SSE

1. One snapshot of Pi conversation projection (no control pendingGate).
2. Subsequent genuine parent `AgentSession` events.
3. Heartbeats only.

Reconnection starts with a new snapshot. Session delete removes conversation data only — **not** WikiRuns control records or sealed artifacts (ADR 0035).

### Run SSE

1. Initial secret-free `WikiRunSnapshot` + cursor.
2. `run.event` frames with full snapshot after each control revision.
3. Heartbeat comment frames (no event id).

Attempt transcripts use separate GET/SSE under `…/attempts/:attemptId/transcript`.

## Durability and deletion

| Store | Lifetime |
|-------|----------|
| Pi Session JSONL | Operator conversation; deleted with Session |
| `workflow.sqlite` | Runs, nodes, gates, effects; survives Session delete |
| Sealed artifacts under run work dir | Spec, wiki trees, transcripts, publication candidates |
| Published Wiki / sources / skill fork | Independent retained data |

## Forbidden parallel paths

- Session-owned whole-Run tool Promise / in-memory `pendingGates`
- Fat live `wiki_produce` details carrying Spec/graph as control truth
- Session `resume_gate` / `start_wiki_run` commands
- Observation-only `run-graph.json` as live authority (Definition v1 + WikiRuns snapshot only)
- Dual topology generators (`topologyFromSpec` removed)
- Product-injected Pi messages or synthetic control SSE on the Session channel
