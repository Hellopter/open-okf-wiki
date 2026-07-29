# Bound provider transport retries (layered budgets)

**Status:** accepted (supersedes PydanticAI Tenacity wording)  
**Date:** 2026-07-28  
**Related:** [ADR 0012](0012-treat-manual-retry-as-a-new-run.md) (manual retry), [ADR 0030](0030-pi-agent-harness-for-semantic-workflow.md) (Pi harness), [ADR 0033](0033-run-graph-and-agent-layering.md) (Run Graph / layering), [ADR 0035](0035-durable-wikiruns-control-plane.md) (WikiRuns control plane / L_control)

## Context

Wiki Run child sessions call providers that return transient failures (HTTP 429/5xx, connection drops). A second product-level loop that reopens a new in-memory session after Pi already retried destroys compaction state and multiplies budgets. Context overflow is a capacity problem, not a transport problem. Control-plane auto-requeue (when allowed) must reuse the same generation and `input_digest`, never invent a second transport stack.

## Decision

Retry authority is layered. Each layer has a distinct budget and never reopens a session for the wrong class of failure.

### 1. L0 — Pi `settings.retry` (in-session transport only)

Injected at `createWikiSession` from `Workspace.limits.retry` (shape mirrors Pi 1:1). Retries stay inside one `AgentSession` / `prompt()` so compaction history is preserved.

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Agent-level auto-retry |
| `maxRetries` | `2` | Extra attempts after the first call (≤ 3 total) |
| `baseDelayMs` | `2000` | Exponential backoff base |
| `provider.maxRetries` | `0` | Nested SDK retries (keep 0) |
| `provider.maxRetryDelayMs` | `60000` | Cap server Retry-After |

**What is retried:** transient provider/transport errors only (429, 5xx, connection, overload). Auth, invalid request, quota/billing, and **context overflow** are not transport-retried.

**Waits count against** child `requestTimeoutSeconds` (session wall-clock).

### 2. L0 compaction — Pi `settings.compaction`

Context overflow is handled by Pi compaction (one compact-and-retry inside the same session). If compaction cannot free enough room, the Attempt fails as **`capacity`**. Capacity is **not** transport-retried at L0 and is **never** auto-requeued by L_control.

### 3. L_control — WikiRuns research auto-requeue (ADR 0035)

After L0 exhaustion, the node Attempt fails with a typed `failureClass` (e.g. `infrastructure` for post-L0 transport, or `capacity` / `budget` / …). WikiRuns may **auto-requeue** only:

- kinds `research.leaf` / `research.domain`
- **once** extra Attempt (`RESEARCH_AUTO_RETRY_MAX_ATTEMPTS = 2` total per generation)
- same node generation + exact `input_digest`
- `failureClass` ∈ {`infrastructure`, `transient`}
- **NEVER** for `capacity` | `budget` | `policy` | `provider` | `cancelled`
- respect `limits.retry.enabled === false` (off disables L_control requeue too)

Missing `failureClass` is fail-closed unless the error message clearly matches transport/infrastructure patterns. Product defects (e.g. “requires sealed sources”) never auto-requeue.

Write / review / validate / publish stay manual only.

### 4. Manual — `RetryFailedNode` / `RerunNode`

Operators recover via durable commands (ADR 0035):

- **`RetryFailedNode`** — same generation, reuses the failed Attempt’s exact input digest (CAS on generation + attempt id).
- **`RerunNode`** — bumps generation; invalidates only downstream nodes that consumed old output lineage.

Whole-run “Manual Retry Run” with frozen inputs remains the ADR 0012 escape hatch when a new Run identity is preferred over in-graph retry.

### Other

- **Infrastructure vs defects.** Reviewer transport failures must not become `reviewer_error` DefectItems or drive repair. Missing reviewer model may still fail-closed as `reviewer_missing`.
- Nested `provider.maxRetries > 0` is an advanced escape hatch and can stack with agent-level retry — default remains 0 per Pi guidance.

## Consequences

- Product configures L0 retry; Pi executes it. No second HTTP client retry stack inside the Attempt.
- L_control may requeue research once for infrastructure/transient only (ADR 0035); capacity/budget/policy never get a blind session reopen.
- `ErrorClass` / Attempt `failureClass` include `capacity` and `infrastructure` for Run Graph observation; failed Attempts persist `failure_class` on the control store for audit and retry policy.
- Manual recovery is command-based (`RetryFailedNode` / `RerunNode`) or a new Run (ADR 0012), not an unbounded workflow loop.
