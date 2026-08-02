# Agent Workflow Observability UX Research

**Date:** 2026-08-02  
**Status:** Research note only. Not an ADR or implementation plan.  
**Question:** How should a Wiki-generation product present a durable workflow graph with fan-out, fan-in, review/repair loops, historical messages, tool activity, and a concurrently running live stream without corrupting the operator's selected historical context?

## Executive conclusion

Do not make a workflow graph or an event stream a single mutable "current run" panel. A long-running agent has at least three different but connected objects:

```text
Thread / Session                 Run snapshot                    Attempt / trace
----------------                 ------------                    ---------------
conversation across turns  -->  graph, plan, artifacts      -->  messages, tools,
operator intent and steering     node/attempt lineage             outputs, errors
                                      ^                                  ^
                                      |                                  |
                              live status projection          selected historical record
```

The selected attempt is a historical record identified by `attemptId` (and, if it is still executing, a stream cursor). Incoming live events may update the Run's *overview* and the active node's *live tail*, but they must not replace the content of the attempt the operator selected. This is the practical implication of the thread/run/item separation in Codex, the thread/message/details split in LangSmith, and durable event history in Temporal. [Codex App Server](https://learn.chatgpt.com/docs/app-server), [LangSmith trace views](https://docs.langchain.com/langsmith/view-traces), [Temporal History Service](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md)

## Evidence from mature systems

| Product | Official evidence | Transferable design rule |
| --- | --- | --- |
| LangSmith trace UI | A thread is the primary navigation unit. It provides a chronological **Messages** view for the full conversation, a collapsed **Turns** overview, and a single-run **Details** debugger. Selecting a message or tool opens the exact producing run; switching tabs preserves collapsed/expanded message state. Parallel tool calls are grouped. [View traces](https://docs.langchain.com/langsmith/view-traces) | Retain thread context while an operator drills into a selected record. Do not replace the whole transcript with the latest event. Group concurrent tools under the agent action that caused them. |
| LangGraph / LangSmith Studio | Graph mode is for architecture, traversed nodes, and intermediate states; Chat mode intentionally has a simpler purpose. LangGraph explicitly represents parallel work as a fan-out/fan-in super-step, and a join runs after all branches complete. Successful branch results are retained on resume; retry policy retries only the failing branch. [LangSmith Studio](https://docs.langchain.com/langsmith/studio), [Graph API](https://docs.langchain.com/oss/python/langgraph/use-graph-api) | Draw concurrency as a bounded sibling group plus an explicit join, not as a long serial list. A retry is a new attempt of a particular failing branch, not an ambiguous change to every completed sibling. |
| Codex App Server | The rich-client model separates persistent **threads**, a user-request **turn**, and typed output **items**. Clients can read stored threads without resuming them, page stored turn/items, stream item deltas, steer an in-flight turn, and interrupt it. [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Store and render immutable item history separately from live deltas. Keep selection by stable id. "Follow live" is a deliberate user mode, not a side effect of receiving a notification. |
| Claude Code | Complex work has a durable task list with pending/in-progress/completed states. Background commands receive stable task IDs and retain retrievable output while the conversation remains usable. [Interactive mode](https://code.claude.com/docs/en/interactive-mode) | The default progress signal must be compact and stable. Background work needs a named, inspectable identity and preserved output rather than an ephemeral spinner or toast. |
| Temporal | Workflow history is append-only and can reconstruct execution state. A normal history is linear; resets/conflict resolution create a branching topology. Failures and retry scheduling are durable lifecycle facts, not a rewrite of prior success. [Architecture](https://github.com/temporalio/temporal/blob/main/docs/architecture/README.md), [History Service](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md) | Preserve completed attempts and model repair/retry as a new edge/attempt with a reason. The view can summarize history, but must never mutate a previous attempt into the later one. |

## Design constraints

### 1. Historical selection wins over live streaming

The present failure mode is a state-ownership bug: a component has one `messages` value that simultaneously means both “messages for the selected plan attempt” and “latest messages received from any running attempt.” The latter overwrites the former when SSE arrives.

Use separate view state and event stores instead:

```text
Run event store (authoritative projection)
  attemptsById[attemptId] = immutable ordered trace items + status + version/cursor
  liveAttemptId            = attempt currently receiving deltas, if any
  graphSnapshot             = nodes + edges + attempt lineage

Observation UI state (operator choice)
  selectedAttemptId
  selectedNodeId
  followMode = "off" | "selected-live" | "latest-live"
  unseenLiveEventCount
```

Rules:

1. Selecting a node resolves to a concrete attempt. If a node has been retried, show an attempt chooser ordered by round/time; do not silently jump to the newest retry.
2. Every streamed event is merged by its immutable event/item id and attempt id. It can append a delta to the active attempt, but cannot set `selectedAttemptId` or replace another attempt's item list.
3. A refresh/reconnect can replace the **run store** with a newer snapshot plus events after its cursor. It must retain the selected id when that attempt still exists and render that attempt's preserved content.
4. When an unselected attempt receives activity, update its graph/status badge and show a compact non-disruptive “new activity” affordance. Do not scroll, change tabs, open a detail surface, or replace the selected content.
5. Offer an explicit “follow active attempt” control. It may auto-scroll only while enabled and only for the selected active attempt. Switching to a historical attempt disables it.

LangSmith's separation of Messages, Turns and Details, while retaining context around a selected run, is the closest direct UI precedent. [View traces](https://docs.langchain.com/langsmith/view-traces) Codex makes the underlying requirement explicit by offering stored thread/item reads separately from streamed `item/*` notifications. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

### 2. Render the execution graph as a layered, semantic topology

The graph must be diagnostic and truthful, not a decorative horizontal row. It should use a deterministic layered layout based on the immutable run snapshot and preserve positions during live updates whenever the topology has not changed.

```text
Plan -> Plan gate -> [ Research A ] --\
                    [ Research B ] ----> Evidence join -> Write -> Validate
                    [ Research C ] --/                          |
                                                                  v
                                                   Review -> Repair round 1
                                                      ^          |
                                                      \----------/
                                                              |
                                                           Publish
```

Required layout behavior:

- **Main path:** left-to-right phase progression. A phase is a visual region, not an arbitrary column of same-sized cards.
- **Fan-out:** siblings that actually execute concurrently share a bounded group container and the same rank. Their source edge enters the group; their result edges converge at an explicit join/barrier node. This communicates both parallelism and the wait condition. LangGraph documents this exact fan-out/fan-in execution relationship. [Graph API](https://docs.langchain.com/oss/python/langgraph/use-graph-api)
- **Variable cardinality:** when a fan-out has many leaves, show a capped grid/summary node (for example “12 research tasks”) at overview zoom and expand that one group on demand. Do not let twenty leaf cards stretch every later phase or force unreadable global zoom.
- **Repair/review loop:** render each executed loop round as a distinct attempt/round in a `Review & repair` region. Use a labeled return edge such as “blocking defects -> repair 1”; route it in a dedicated outer lane. Never draw an unlabeled line through a node or collapse different rounds into one mutable `repair` card.
- **Conditional path:** show unused optional paths as subdued only when their existence helps explain the workflow. Do not show every theoretical edge. The Studio documentation notes that undefined conditional paths create misleading graph connections; actual paths should be explicit. [Studio troubleshooting](https://docs.langchain.com/langsmith/troubleshooting-studio)
- **Edges and labels:** edge labels reserve geometry, edges never cross card content, and arrowheads remain visible. A card has a stable max width and a fixed collapsed height. Title wrapping is limited; full names belong in the selected-detail header/tool tip, not a dynamically widening graph card.
- **Zoom levels:** fit-to-run may summarize groups; entering a group or selecting a node moves to a focused subgraph. Do not solve density by reducing all type to illegible size.

This is compatible with graph runtime semantics: parallel siblings may complete in a nondeterministic order, so the graph should communicate rank/concurrency, while the trace supplies chronology. [LangGraph Graph API overview](https://docs.langchain.com/oss/python/langgraph/graph-api)

### 3. Keep the graph overview and detail reader coequal, not drawer-shaped

The operator needs enough width to read model output, tool I/O, source receipts and Markdown. A narrow right drawer is insufficient as the primary attempt reader.

For desktop, use a resizable two-region execution workspace:

```text
Run header: objective | state | gate / stop / follow controls
-----------------------------------------------------------------
Graph overview / semantic phase map       Selected attempt reader
node state, parallel group, loop          title, attempt picker,
current/unseen activity                   Messages | tools | plan | events
-----------------------------------------------------------------
Full-width artifact / review area when a plan, candidate, or gate is selected
```

The graph is a navigable map and status surface; selecting a node changes the neighboring/main reader, not an overlaying drawer. On small screens, use full-width tabs/routes for **Overview**, **Trace**, and **Artifact**, retaining selection in the URL so navigation does not lose it. Graph mode versus simplified chat mode in Studio is a useful distinction: rich graph diagnostics are not a reason to constrain reading space. [LangSmith Studio](https://docs.langchain.com/langsmith/studio)

### 4. Render message and tool history as one ordered, readable narrative

The selected attempt reader is not a raw JSON/event log. It is a chronological, role-aware rendering of persisted typed items:

- User/operator direction and plan changes retain Markdown and source links.
- Assistant messages render in full Markdown; streaming text becomes final content in the *same item*, keyed by id, rather than a second duplicated message.
- An assistant item's tool calls appear directly under the initiating message. Parallel calls are a collapsed group with individual status and duration. Results pair by tool-call id, not just display order.
- Failed tool results open enough diagnostic content to act, while large payloads, prompts and successful output default to collapsed with copy/download/expand controls.
- Plan revisions, review defects, repair scheduling, gates and terminal outcomes are semantic timeline cards linked to their bound artifact/attempt, not indistinguishable system prose.
- The raw event feed remains available for forensic support, sorted by sequence/cursor and with an explicit reconnect/truncation marker.

LangSmith uses this exact progressive pattern: full Messages for orientation, collapsed Turns for structural scanning, then Details for inputs, outputs, timing, errors and metadata. Tool calls stay with the assistant message that caused them, and concurrent calls are grouped. [View traces](https://docs.langchain.com/langsmith/view-traces) Its documented trace schema also pairs tool results to calls with a stable `toolCallId`, which is the appropriate rendering key. [Messages view trace format](https://docs.langchain.com/langsmith/messages-view-trace-format)

### 5. Treat retries, repairs, and resumed runs as lineage, not replacement

An attempt card needs a status and an immutable identity. A retry creates another card/row connected to its cause; it does not mutate the old failed card into a success. The same applies to a repair loop: completed review evidence remains visible while repair `N` begins and is later re-reviewed.

At overview density, express this as a compact lineage badge such as `3 attempts: 1 failed, 1 repaired, 1 current`. In detail, expose the ordered chain, the scheduling reason, durable input/state revision, exact error or defect set, and outcome. This preserves the ability to compare before/after without falsely implying that a failed attempt never happened.

Temporal's append-only history and LangGraph's checkpoint/replay model both support this rule: prior completed work is preserved while work after a checkpoint may be re-executed. [Temporal History Service](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md), [LangGraph time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)

## Product acceptance criteria derived from the evidence

1. While a Run is active, opening a historical plan/research/review attempt keeps its Markdown messages, tool calls and results visible even as other nodes emit new SSE events.
2. A selected node with multiple attempts opens an explicit attempt history, defaults to a deterministic attempt, and never silently changes selection on retry.
3. The overview identifies active and unseen nodes without disrupting the operator's current reader or scroll position.
4. The graph represents actual fan-out/fan-in groups and actual repair/review rounds, with no edges through cards, clipped labels, overlapping cards, or typography reduced below readable UI size.
5. Clicking a graph node opens a full-width/resizable detail reader with historical messages, rendered Markdown, tool call/result pairing, plan/review artifacts and raw event data; no narrow drawer is required to inspect a trace.
6. Refresh/reconnect restores a snapshot plus monotonic events after a cursor, preserves the selected attempt when available, and makes any live-event gap visible rather than silently rewriting history.

## Limits of the comparison

LangGraph and Temporal are workflow/runtime products, while Codex and Claude Code are coding-agent products. They should not dictate Wiki page, citation or publication UX. Their common lesson is narrower: durable history, typed live events, selected-record inspection, visible concurrency, and explicit retry lineage are necessary for an operator to trust a long-running system. The WikiRun control plane remains the owner of Wiki artifacts, gates and publication effects.
