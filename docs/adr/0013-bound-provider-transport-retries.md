# Bound provider transport retries (Pi settings.retry)

**Status:** accepted (supersedes PydanticAI Tenacity wording)  
**Date:** 2026-07-28  
**Related:** ADR 0012 (manual retry = new run), ADR 0030 (Pi harness), ADR 0033 (Run Graph / layering)

## Context

Wiki Run child sessions call providers that return transient failures (HTTP 429/5xx, connection drops). A second product-level loop that reopens a new in-memory session after Pi already retried destroys compaction state and multiplies budgets. Context overflow is a capacity problem, not a transport problem.

## Decision

1. **Single transport budget — Pi `settings.retry`.**  
   Injected at `createWikiSession` from `Workspace.limits.retry` (shape mirrors Pi 1:1):

   | Field | Default | Meaning |
   |-------|---------|---------|
   | `enabled` | `true` | Agent-level auto-retry |
   | `maxRetries` | `2` | Extra attempts after the first call (≤ 3 total) |
   | `baseDelayMs` | `2000` | Exponential backoff base |
   | `provider.maxRetries` | `0` | Nested SDK retries (keep 0) |
   | `provider.maxRetryDelayMs` | `60000` | Cap server Retry-After |

2. **Same session only.** L0 retries stay inside one `AgentSession` / `prompt()` so compaction history is preserved. L2 (`runNodeAttempt`) **must not** reopen a session for `transient` or `capacity`.

3. **What is retried.** Transient provider/transport errors only (429, 5xx, connection, overload). Auth, invalid request, quota/billing, and **context overflow** are not transport-retried. Overflow is handled by Pi compaction (one compact-and-retry); failure classifies as `capacity` and fails the node.

4. **Waits count against** child `requestTimeoutSeconds` (session wall-clock).

5. **After L0 exhaustion**, the node fails with `errorClass: transient` (or capacity/budget/…). The Wiki Run does not auto-restart. Operators may raise `limits.retry` or create a **Manual Retry Run** (ADR 0012).

6. **Infrastructure vs defects.** Reviewer transport failures must not become `reviewer_error` DefectItems or drive repair. Missing reviewer model may still fail-closed as `reviewer_missing`.

## Consequences

- Product configures retry; Pi executes it. No second HTTP client retry stack.
- `ErrorClass` includes `capacity` and `infrastructure` for Run Graph observation.
- Nested `provider.maxRetries > 0` is an advanced escape hatch and can stack with agent-level retry — default remains 0 per Pi guidance.
