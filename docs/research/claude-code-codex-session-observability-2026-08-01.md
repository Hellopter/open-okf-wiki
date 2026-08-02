# Claude Code and Codex: Session and Observability Research

**Date:** 2026-08-01  
**Status:** Research note only. Not an ADR or implementation plan.  
**Question:** For a long-running Wiki-generation product, should a durable operator conversation, repeated `wiki_produce` calls, and detailed run observability coexist? What product architecture is supported by comparable agent products?

## Executive conclusion

Yes. The comparison does not support choosing either a conversation product or a durable Run product. Claude Code and Codex both make a persistent thread/session the place where the operator returns, gives follow-up direction, and retains context. They also expose separate, live views of execution, tool results, decisions, artifacts, and review output.

The relevant design is therefore:

```text
Workspace
  +- Operator Session (one durable conversation, 0..N WikiRuns)
  |    +- messages, plans, tool calls/results, follow-up instructions
  |    +- wiki_produce / wiki_repair as executable tools
  |
  +- WikiRun (one durable, independently recoverable production workflow)
       +- phases, nodes/attempts, live event stream, artifacts, gates, review
```

`Session` is the collaboration and semantic-continuity boundary. `WikiRun` is the durable execution, audit, and publication boundary. Neither is a substitute for the other. Removing browser access to the first makes the agent unable to collaborate over time; hiding the second makes its work unverifiable.

## Official product evidence

| Product | Official evidence | Transferable principle |
| --- | --- | --- |
| Claude Code sessions | A session persists prompts, every tool call, every tool result, and responses; it can be resumed after interruption or forked for alternatives. The conversation is persisted separately from filesystem changes. [Claude Code Agent SDK: sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Persist the conversation and tool trace as a first-class object; a Run must not erase the ability to ask follow-ups in that context. |
| Claude Code session UX | Claude Code saves sessions locally, lets users resume/switch/name/branch them, and offers a session picker. [Manage sessions](https://code.claude.com/docs/en/sessions) | Provide a Workspace-scoped session index, title, history and resume, rather than treating each invocation as disposable chat. |
| Claude Code task visibility | Complex work has a task list with pending/in-progress/done states, surviving context compaction; background commands receive IDs and their output can be retrieved. [Interactive mode](https://code.claude.com/docs/en/interactive-mode) | Status must be visible while work continues. Give stable IDs and a history for asynchronous units rather than only a final success/failure toast. |
| Claude Code planning | Plan mode explores without edits; the produced plan can be approved, refined, or edited before execution. [Permission modes](https://code.claude.com/docs/en/permission-modes) | A plan is a reviewable artifact and decision point, not a transient assistant paragraph. It needs a durable presentation and a feedback loop. |
| Codex threads and skills | Codex uses project-organized agent threads, supports parallel work, preserves existing session history/configuration, and lets users review changes/comment in the thread. Skills package instructions, resources and scripts for repeatable workflows. [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/) | A tool executes an operation; a skill teaches when/how to use it. Keep `wiki_produce` callable as a tool, and use a Wiki skill for operational policy and quality constraints. |
| Codex rich-client protocol | The Codex App Server is the official rich-client interface for conversation history, approvals and streamed agent events. It separates persistent `thread`, interruptible/steerable `turn`, and typed `item`; threads can be listed/read/resumed/forked. [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Treat conversation, a submitted turn, and each visible execution item as related but distinct records. Do not hide all items behind one final Run status. |
| Codex event model | Codex exposes plan updates with pending/in-progress/completed steps and typed item lifecycle/delta events for messages, reasoning summaries, command execution, file changes and dynamic tool calls. [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Live streaming and history replay should show the same typed evidence, keyed by stable IDs. The default should summarize; the inspector should retain exact messages and tool I/O. |
| Codex live supervision | Codex makes the active machine's live threads, approvals, project context, screenshots, terminal output, diffs and test results available remotely in real time. Users can change direction or approve an identified decision point without losing the running context. [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/) | The operator needs an active-work surface with live updates and a clear intervention path. Raw logs are useful, but must be paired with meaningful progress and explicit blockers. |
| Codex long-running work | OpenAI describes Codex as a persistent workspace for preserving context, managing complex workflows, and sustaining work beyond a single prompt. [Codex-maxxing for long-running work](https://openai.com/index/codex-maxxing-long-running-work/) | A long task is not a detached job queue. It needs durable context and an easy way to return to and continue the same workstream. |
| Codex Projects and long-running work | OpenAI documents Projects as shared context across related chats and Long-running work as a durable objective that can be paused, resumed and redirected in the same thread. [Projects](https://learn.chatgpt.com/docs/projects), [Long-running work](https://learn.chatgpt.com/docs/long-running-work) | Workspace context, a Session/Chat, and a concrete task are separate levels. New outcomes can use a new Run without discarding the shared conversation. |
| Codex scheduled work | Scheduled work has separate active/paused/completed states and run history; independent runs start new chats, while some automations can return to the same conversation context. [Scheduled tasks](https://learn.chatgpt.com/docs/automations) | Model “new execution” and “continue the existing conversation” as distinct operations. A repeated Wiki generation may create a new Run while remaining inside the same Session. |

## Synthesis: the three surfaces that must coexist

Comparable products converge on three complementary surfaces. Combining them into a single chat transcript loses reviewability; keeping only the task surface removes contextual collaboration.

| Surface | Primary question | Durable data | Default information density |
| --- | --- | --- | --- |
| Session conversation | “What are we trying to achieve, and what should happen next?” | messages, assistant reasoning summaries, tool call/results, session plan, user feedback | concise but complete chronological context |
| Run workspace | “What is this generation producing, where is it blocked, and what decision is needed?” | immutable run intent, plan/spec, lifecycle state, gates, candidate and publication result | artifact/phase first |
| Run inspector | “What exactly occurred in this node/attempt/tool call?” | streamed and historical messages, tool I/O, citations, event log, retry/error diagnostics | detail on demand |

The browser should let an operator move between them through stable links:

```text
Session message
  -> wiki_produce tool receipt (runId, mode, stated intent)
  -> Run workspace
  -> selected node / attempt / tool event inspector
  -> add run direction or return to the Session
```

This is not duplicated state. The Session is the authoritative Pi conversation record; the Run is the authoritative Wiki workflow record. UI views are projections of these sources.

## Tool versus Skill

`wiki_produce` should be a **tool**, because its invocation creates a concrete durable operation and returns a receipt with an identity. It needs typed inputs such as mode, scope, source constraints and operator notes, and typed outputs such as `runId`, state, and a deep link.

A `wiki-production` **skill** should complement it, not replace it. It should contain instructions and resources that help the agent decide:

- whether the operator is asking for a new generation, refresh, repair, explanation, or investigation;
- when it must ask a clarifying question instead of starting a Run;
- how to construct the tool parameters and attach source/quality constraints;
- how to explain a receipt, link to the Run, and summarize an eventual result.

This maps directly to Codex's documented distinction: a tool exposes a controlled action/data capability, while a skill supplies reusable instructions for when, in what sequence and with what output handling to use tools. [Skills](https://developers.openai.com/plugins/concepts/skills)

## Architecture implications for this repository

### 1. Restore the full composition boundary, not the retired monolithic cockpit

The current codebase already preserves the deep primitives: `createOperatorSession`, the `wiki_produce` tool, Run `sessionId` command context, `operator_session_id` storage, WikiRun events, attempts, artifacts and gates. The deleted code removed their HTTP/SSE/browser composition, not the core capability.

The correct repair is a first-class `OperatorSession` module with a narrow public interface:

```ts
type OperatorSessionService = {
  create(workspaceId: string): Promise<SessionSummary>
  list(workspaceId: string): Promise<SessionSummary[]>
  open(workspaceId: string, sessionId: string): Promise<SessionHistory>
  submit(workspaceId: string, sessionId: string, prompt: string): Promise<AcceptedCommand>
  stream(workspaceId: string, sessionId: string): EventStream
  listRuns(workspaceId: string, sessionId: string): Promise<WikiRunListItem[]>
}
```

It should adapt the existing Pi session manager and `wiki_produce`/`wiki_repair` tools. It must not duplicate the WikiRuns state machine, node execution, gates, retry rules, or publication effects.

### 2. Make cardinality explicit

The correct relation is **one Session to zero or more Runs**. Starting a second `wiki_produce` call creates a second Run with the same `operator_session_id`; it does not replace or reopen the first Run. A Run may also be started without a Session for API/automation entry points, so the reverse relation is optional.

```text
Session S
  +- Run R1: generate "TypeScript guide"
  +- Run R2: refresh R1 after new sources
  +- Run R3: generate a separate "API reference" wiki
```

Run provenance should carry `sessionId`, tool call ID and source Session message ID. The receipt in the Session should carry `runId`. The relationship should be queryable, rather than reconstructed from free text.

### 3. Restore observability as a product requirement

The desired observability is not merely a debug console. It has two levels:

- **Run summary by default:** current phase, objective, page/evidence/validation progress, current meaningful action, known blockers, time since meaningful progress, and the next operator decision.
- **Forensic detail on demand:** node/attempt history; assistant messages; tool invocations and I/O; event stream; plan revisions; evidence receipts; error stacks/digests; retry/cancel/steer actions; and links back to the originating Session message.

Every event needs both a historical record and a live projection. A reconnect must replay a snapshot plus events after a cursor, so observing a long generation does not depend on leaving a browser tab open.

### 4. Keep plans, gates and artifacts addressable

The plan needs an immutable revision ID, readable full content, inputs/constraints, status, authoring timestamps and an explicit approve/request-change/cancel decision record. A gate should always reference the exact artifact revision it authorizes. This is the analogue of Claude Code's reviewable plan, adapted to Wiki publication rather than filesystem permissions.

### 5. Separate intervention semantics

Expose different commands because they have materially different guarantees:

| Command | Scope | Meaning |
| --- | --- | --- |
| Session follow-up | conversation | adds context or starts a new line of work; may invoke a tool |
| Run direction | one Run | applies/queues an instruction to the active execution at a safe boundary |
| Approve/reject plan or publish | one bound artifact revision | durable operator decision |
| Pause/cancel | one Run | stops durable execution while preserving audit/history; never erases publication evidence |
| Retry a node | one bounded failure | creates a new attempt under the same Run |

Avoid relabelling all of these as generic “chat.” That hides side effects and makes the audit log ambiguous.

### 6. Restore bounded automatic repair instead of making every defect a human gate

The current v5 workflow contains `repair.N`, but its defaults make the observed
experience effectively manual:

- Mechanical model repair is eligible only after a `validate.pre` or
  `validate.final` failure and only when
  `mechanical.modelRepairBudget > 0`. The default budget is `0`, so its
  scheduler predicate always declines the repair.
- Host-only deterministic cleanup (citation canonicalisation, citation line
  clamping, and index regeneration) still runs, but it cannot repair semantic
  omissions, page structure, coverage, or reviewer defects.
- A blocking semantic review result opens `gate.fix`; the only path to a
  semantic `repair.N` is the human `fix` decision. The default semantic budget
  is `2`, but it is a ceiling for an operator-approved repair, not an automatic
  retry policy.

This is a policy choice, not a durability requirement. The redesigned execution
policy should distinguish bounded, evidence-backed automated correction from
human product decisions:

| Outcome | Default action | Escalate to human when |
| --- | --- | --- |
| Deterministic mechanical defect | Fix in place, validate again, record the exact diff | The fix changes source claims or cannot revalidate |
| Repairable validation or reviewer defect | Automatically schedule one bounded `repair.N`, then re-run validation and review | Budget/candidate cap is reached, the repair broadens scope, or a defect remains blocking |
| Plan scope or source-policy conflict | Do not auto-rewrite the objective | The execution plan, source set, or acceptance contract must change |
| Publication | Never auto-publish merely because repair passed | The operator approves the exact sealed candidate |

The default should be one automatic semantic repair round and one automatic
mechanical model-repair round, both frozen into the Run's acceptance policy and
fully observable. Further repair, scope expansion, exhausted budget, policy
failure, or publication remains an explicit operator decision. This preserves
the existing Run boundary while restoring an agent's expected ability to
diagnose, correct, verify, and report its own bounded mistakes.

## Product direction

This should be a broad capability restoration and redesign, rather than another narrow patch:

1. **Session Center:** a Workspace-scoped thread list with history, titles, resume/branch-or-new semantics, a full composer, tool receipts, and links to all related Runs.
2. **Run Workspace:** a first-class route opened from a tool receipt or run index; it is artifact-first and phase-aware, not merely a list of nodes.
3. **Live Trace Inspector:** selectable node/attempt/tool/message/event tabs with reconnect/replay, pinned errors, and deep links.
4. **Plan and review surface:** readable plan/spec/candidate revisions, diffs where meaningful, and explicit gate decisions with feedback history.
5. **Unified work index:** one scan-friendly project dashboard combining Sessions and Runs without pretending they are the same object. It should show active work, needs-input, failed, published and recently updated items.
6. **Skill package:** make Wiki operating policy and tool-use guidance visible/versioned, while retaining executable `wiki_produce` and `wiki_repair` tools.

The implementation should replace, rather than revive, the old Cockpit wholesale. Reuse durable protocol/domain code and UI primitives where they remain sound, but define the Session-to-Run contract and observability event model before building pages. Otherwise a new UI will again become a shallow projection that loses state when requirements grow.

## Acceptance criteria for the redesign

- A user can create/resume a Session, inspect all prior messages and tool calls, then give a follow-up without restating the work.
- One Session can start multiple `wiki_produce` calls, each producing a different durable Run that remains linked to its exact initiating tool receipt.
- A running Run exposes live and historical node messages, tool use/results, plan/spec revisions, attempts, evidence, errors, and gates after page refresh/reconnect.
- The default Run view answers objective, phase, latest meaningful progress, blocker, and next operator action without reading raw trace logs.
- Tool/run loss, browser disconnect, and Session process eviction do not erase durable Run state or observability history.
- Session deletion is explicitly scoped to conversation retention and cannot silently delete Run audits, artifacts or published Wiki output.

## Limits of the comparison

Claude Code and Codex operate on code/files; this product produces a Wiki with its own publication and provenance semantics. Their UI should not be copied literally. The transferable principles are durable threads, observable asynchronous execution, reviewable plans/artifacts, stable tool receipts, and explicit human intervention. WikiRuns must retain ownership of publication gates, artifacts and idempotent effects.
