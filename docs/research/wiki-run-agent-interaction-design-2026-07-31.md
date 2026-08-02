# WikiRun Agent Interaction Design Research

**Date:** 2026-07-31  
**Status:** Research note only. Not an ADR or implementation plan.  
**Question:** How should a long-running, human-supervised WikiRun interact in the web UI, given that the current side-panel experience is difficult to follow?

## Executive conclusion

The product needs a **Run Workspace**, not a more elaborate sidebar. A WikiRun is a durable work object with a plan, evidence, page artifacts, review defects, gates, and a publication result. The operator chat should remain a way to start and steer it, but it should not be the primary place to discover its state.

Use sidebars for **indexes and quick switching** only: recent sessions, recent runs, unread/needs-attention state, and a compact result. When the operator opens or starts a run, make that run the center of the page. Put phase progress, the current meaningful artifact, and the next human decision in the central work area; reserve the right inspector for an individual attempt, receipt, tool log, or source citation.

This is consistent across the relevant products. Cursor's sidebar is an agent index that leads to an agent/detail environment, not its full execution surface. GitHub Copilot separates the Agents list from a session overview and log. Codex uses independent agent threads/worktrees with review artifacts. Devin puts a progress worklog, IDE, diffs, and takeover in the session. Claude Code distinguishes durable task status, plan approval, and background task inspection. [1][2][3][4][5][6]

## Current WikiRun model and UI audit

The product model already supports a much better interaction than the UI currently exposes.

```text
Operator Session (prompt / steer)
        |
        +-- StartRun receipt
                 |
                 v
WikiRuns durable control plane
freeze -> plan -> plan gate -> research -> write -> validate/review/repair
       -> publication gate -> publish
                 |
                 +-- immutable artifacts, attempts, gates, events, candidate
```

`WikiRuns` owns the durable Run, nodes, attempts, gates, artifacts, effects, and its own SSE stream; Pi owns only a discardable Attempt. The user-facing lifecycle is therefore not just a chat turn and should not be rendered as one. [10] The current `v3` execution contract additionally identifies the user-facing semantic artifacts: `RunIntent`, frozen manifest, `WikiSpec`, `ExecutionPlan`, evidence/receipts, candidate Wiki, defect reports, and sealed operator input. [11]

### Current web interaction

The Operate page has a valid base: persistent conversation, a session list, a separate Run SSE projection, a plan/spec renderer, gates, attempts, and a node inspector. However, it makes the Run secondary:

1. The main surface is a transcript with an action dock at the bottom. `wiki_produce` is initially a nested tool receipt that shows a short run id and summary. [15]
2. The active run summary and gate action live below the scrolling transcript and above the composer. The Plan is not a first-class current artifact; it is behind the optional Run Cockpit and then an accordion. [13][14]
3. On wide screens, the Cockpit is an opt-in right panel (32% by default), opened from a small toolbar icon. On narrower screens it becomes a sheet/drawer. It contains progress, attention, graph, attempt history, and Plan. [12][13]
4. The left sidebar is also present for Session navigation. The result is that the operator divides attention among session navigation, a chat timeline, the bottom dock, a hidden/optional run inspector, nested tool details, and attempt dialogs.

The UI is not missing data. It makes the durable work object's primary questions costly to answer:

| Operator question | Current place | Friction |
| --- | --- | --- |
| What is this run trying to deliver? | Tool receipt / plan accordion | Intent and plan are not the page's primary object. |
| Where is it in the lifecycle? | ActiveRunBar plus optional Cockpit | Status is split between the bottom dock and a hidden right panel. |
| What should I do now? | Gate at the dock, error/failed node in Cockpit | Attention is distributed instead of becoming the focal view. |
| What has it produced and what is left? | Graph, attempts, artifacts through separate surfaces | The page-level/wiki-level outcome is not the default progress measure. |
| What happened inside a worker? | Node dialog/attempt transcript | Appropriate as a drill-down, but currently too close to the main way of understanding progress. |

This aligns with the repository's earlier UI audit: it called out chrome overload, gates buried in tool details, a graph that did not make dependencies clear, and the need to elevate `wiki_produce` to a Run Cockpit. [16]

## Product evidence and transferable patterns

| Product | Official interaction evidence | Transferable pattern |
| --- | --- | --- |
| Claude Code | Complex work gets a durable checklist with pending/in-progress/done state; background tasks have a separate manager; Plan mode is a read-only stage with a review/approve/refine transition. [1][9] | Make the plan and phase state durable artifacts, not prose lost in a chat. Separate a concise work list from detailed worker logs. |
| Codex | Goal mode has a persistent progress row above the composer with pause/resume/edit/clear; steering happens in the same thread. Subagents appear as inspectable child threads, while the main agent receives summaries. [2][7] | The live objective and controls stay visible. Worker activity is summarized in the main run, with full details on demand. Preserve a single primary ownership thread. |
| Codex app / cloud | Cloud tasks run in isolated environments and are reviewed as code/PR results; app worktrees isolate parallel chats and allow a background-to-foreground handoff. [2][8] | Treat completed output and its evidence as reviewable artifacts, and make handoff/inspection a first-class end state rather than terminal chat text. |
| GitHub Copilot coding agent | An Agents panel is an index; selecting a session shows live log, progress, token usage, and session length. Users can steer without stopping, or stop the session, then review the PR. [3][4] | Queue/index and detail workspace are different surfaces. Distinguish a non-destructive correction from Stop. Link a final deliverable back to its trace. |
| Cursor background agents | The Sidebar lists/searches/starts agents. Selecting an agent moves the user to its status and remote machine, where follow-up and takeover are available. [5] | A sidebar is acceptable for discovery and switching, but the active task must have a dedicated detail context. |
| Devin | A Progress view puts updates, command activity, edits, and browser activity in one context; users can inspect a step, review real-time changes/diffs, stop, take over, and resume with context. [6] | Use a progressive-disclosure worklog tied to meaningful phases. Offer takeover/debug only when it is needed; do not make raw logs the summary view. |

## Proposed interaction model

### 1. Promote a selected run to a central Run Workspace

Use an explicit route/state such as the existing `?run=` selection, but render it as a main workspace rather than an optional sidebar. The session sidebar remains available as a collapsible index. The chat becomes a secondary contextual pane or a timeline below the run summary, rather than the run's only home.

```text
Left index                 Central Run Workspace                         Optional inspector
------------------         -------------------------------------------   -----------------------
Sessions                    Run objective / source scope / state          selected attempt
Recent WikiRuns             Phase strip: Plan > Research > Draft ...      receipt / citations
  needs input               Current artifact or decision                  validation/tool log
  running                   Page/coverage/review outcome                  raw event history
  published                 Steer composer + Stop                          retry diagnostics
```

Opening a run must never require an operator to find the original `wiki_produce` tool card. A start receipt should deep-link/focus the new run immediately. The run list should show only scan-friendly facts: title/objective, state, last meaningful update, and an attention marker; it should not attempt to be a mini graph or mini chat.

### 2. Change the center panel by lifecycle, not by renderer type

The phase strip remains stable, but the center should show the artifact the operator needs at this state:

| Run state | Default central object | Primary operator action |
| --- | --- | --- |
| Planning / plan gate | Readable `WikiSpec` + execution plan: audience, proposed page tree, source scope, acceptance rules, open questions | Approve, request targeted changes, reject/cancel. Inline comments are a useful later enhancement. |
| Research / write | Page-oriented progress: planned/written/reviewed/blocked pages, active work summary, evidence coverage/known gaps | Send direction, inspect a blocked page/receipt, stop. |
| Review / repair | Candidate Wiki + defect summary grouped by severity/page; validation and citation evidence | Accept repair direction, inspect defects, retry the affected bounded unit. |
| Publication gate | Exact candidate to publish, meaningful delta, validation result, bound baseline/version | Publish, return for repair, cancel. |
| Published / failed / cancelled | Final Wiki link and concise outcome; selected evidence and a trace link | Read, start a refresh/new run, inspect audit details. |

Avoid reducing research progress to "N nodes done." Node completion is useful debug information but does not answer whether the Wiki now has page coverage and a publishable candidate. Keep nodes/attempts available from the inspector.

### 3. Make interruption and steering explicit, with different guarantees

The backend already defines the right distinction: a running composer performs `steer`/`follow_up` queue semantics and abort is separate. [11] Surface it in the run workspace:

- **Send direction**: an always-available run composer, labelled as applying to the active run. It adds a constraint, correction, or question and visibly reports whether it was applied now or queued for the next safe boundary.
- **Pause/stop**: a separate, persistent control with direct language about what is preserved. For a durable run, use the existing cancellable state, withdraw gates, and preserve immutable artifacts/audit data; do not imply that it will undo published output. [10]
- **Needs input**: a sticky, in-context decision card, not a badge or an item at the bottom of a chat. It must name the blocker, show its affected artifact/scope, and lead with the choices.

This follows Copilot's separate steer/stop semantics and Codex's pause/resume/goal editing rather than treating every intervention as a new generic chat message. [2][3]

### 4. Give human gates a document-review interaction

A plan or publication approval is an irreversible/change-authorizing decision, so it needs a full review context. Do not make it an expanded tool card, an unlabelled drawer, or a small button beside a run identifier.

For each gate show: the decision required, why it is requested, the bound artifact/candidate, its key changes, validation/coverage status, risks or unresolved questions, and the explicit allowed actions. Keep the decision card fixed while the user reads. Retain the decision and feedback in the run timeline for auditability.

Claude Code's Plan Mode is the relevant interaction: the operator can approve a plan, refine it with feedback, choose the next autonomy level, or edit it before execution. [9] WikiRun should copy the reviewability and explicit transition, not Claude Code's filesystem permission modes.

### 5. Reduce agents to summary cards, retain details as an inspector

The main run should display workers in terms of user meaning, for example "Researching authentication and API domains" and "2 of 3 evidence receipts accepted," with a concise result or blocker. Do not stream each leaf's assistant text into a peer chat timeline. Codex explicitly preserves the main chat by returning subagent summaries; its child threads remain inspectable. [7]

The right inspector is useful after this change. It should contain tabs for the selected `Attempt`, `Evidence/receipt`, `Source`, `Validation`, and `Event log`; selection comes from a page, defect, or phase summary. The DAG may live here or under a "Workflow" secondary tab. It is an operator/developer diagnostic surface, not the default way to understand a Wiki.

## Important limits: do not copy these products literally

1. **Do not replace the control plane with chat state.** Claude/Codex sessions are valuable interaction references, but this product's Run, gates, publication effects, and artifacts must remain WikiRuns-owned and recoverable across session/SSE loss. [10][11]
2. **Do not copy code diffs as the output model.** A WikiRun needs page/citation/coverage/candidate review. Git diffs and PRs are only analogies for reviewable, attributable deliverables.
3. **Do not turn the user into a live worker supervisor.** Devin's terminal/IDE takeover makes sense for a coding VM. Here, default visibility should be page and evidence progress; raw Attempt/tool logs need progressive disclosure and operator-safe redaction.
4. **Do not use an unbounded graph as the home screen.** The graph is valuable for diagnosis and lineage, but graph topology is not the reader-facing work breakdown. Show phase and page progress first, then the graph on demand.
5. **Do not conflate hard gates with routine approval prompts.** File/command permission modes are tool safety mechanics. WikiRun's plan/publication/operator-input gates are product decisions bound to durable artifacts and need their own presentation and audit trail.
6. **Do not permit parallel writers to the same Wiki just because parallel subagents look attractive.** Continue the existing one-writer policy and show parallel research/review as bounded contributions. [11]
7. **Do not create a third source of truth for UI convenience.** The browser should project Operator Session events and Run SSE snapshots/events into view models; it should not hold the live agent/run state itself. [17]

## Recommended delivery order

1. **P0 - Make the selected run central.** On `StartRun`, focus the run; replace the optional cockpit as the default run detail presentation; retain a collapsed session/run index. Put plan and gate review in the central panel.
2. **P0 - Establish an attention model.** One top-level `Running`, `Needs input`, `Ready for review`, `Blocked`, `Published` state, a persistent Stop control, and clear steer/queued feedback. Add browser/desktop notification only for a human decision or terminal result, not every worker event.
3. **P1 - Add artifact-first progress.** Project `WikiSpec`, page states, receipt acceptance/coverage, defects, candidate, and validation into a stable summary. Make "pages ready for review" more prominent than attempt count.
4. **P1 - Make the inspector deliberately secondary.** Move attempts, receipts, source evidence, tool I/O, graph, and raw events behind explicit tabs/selection. Keep deep links to an attempt for support/audit.
5. **P2 - Improve the review loop.** Candidate page preview/diff, line/page-specific feedback, and a clear refresh/new-run/handoff path after publication.

## Sources

### External primary sources

1. Anthropic, [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode). Task list, task state, background task visibility, and interruption behavior.
2. OpenAI, [Long-running work](https://learn.chatgpt.com/docs/long-running-work.md). Goal progress row, pause/resume/edit, steering, and independent parallel tasks.
3. GitHub, [Managing agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents). Agent index, session overview/log, progress, steer, and stop.
4. GitHub, [Get started with Copilot agents on GitHub](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview). Session trace and pull-request review delivery.
5. Cursor, [Background Agents](https://docs.cursor.com/background-agent). Sidebar as agent index; select an agent for status, follow-up, or takeover.
6. Cognition, [Devin Session Tools](https://docs.devin.ai/work-with-devin/devin-session-tools). Unified progress/worklog, command history, diff review, takeover, and resume.
7. OpenAI, [Codex Manual: multi-agent operations](https://learn.chatgpt.com/docs/agent-configuration/subagents.md). Main-thread summaries, inspectable subagent threads, and active/done agent status.
8. OpenAI, [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/). Independent project threads, parallel worktrees, review and handoff.
9. Anthropic, [Choose a permission mode](https://code.claude.com/docs/en/permission-modes). Plan-to-review-to-execution interaction.

### Repository sources

10. [ADR 0035: Durable WikiRuns control plane](../adr/0035-durable-wikiruns-control-plane.md). Durable ownership and lifecycle.
11. [ADR 0036: Semantic artifact plane and execution plan](../adr/0036-semantic-artifact-plane-and-execution-plan.md). Current `v3` artifacts, gates, runtime semantics, and operator surface.
12. [AgentWorkspaceShell](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx). Current shell, optional Cockpit sizing, and responsive sheet/drawer behavior.
13. [RunCockpit](../../packages/web/src/agent-workspace/components/RunCockpit.tsx). Current progress, attention, graph, attempts, and hidden plan.
14. [ActiveRunBar](../../packages/web/src/agent-workspace/components/ActiveRunBar.tsx). Current bottom action dock and gate presentation.
15. [WikiProduceGatePanel](../../packages/web/src/agent-workspace/components/WikiProduceGatePanel.tsx). Current nested StartRun receipt presentation.
16. [UX/UI refactor plan](../design/ux-ui-refactor-plan-2026-07.md). Existing UI audit and intended operating principles.
17. [Agent UI event projection](agent-ui-event-projection.md). Projection boundary and why browser state must remain a view model.
