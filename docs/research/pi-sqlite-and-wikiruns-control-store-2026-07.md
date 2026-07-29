# Pi SQLite, upstream durable discussions, and WikiRuns control store

- **Date:** 2026-07-29
- **Decision:** [ADR 0035](../adr/0035-durable-wikiruns-control-plane.md)
- **Related scratch:** [architecture-review-2026-07-28](../../.scratch/architecture-review-2026-07-28/) (`target-architecture.md`, `pi-durable-workflow-research.md`, `community-durable-workflow-research.md`)
- **Pi checkout referenced in design work:** `65ff8e7f6db447dcddb1a9c8fd05f081c5cda76a` (package declares `0.81.1`)

## Question

Is SQLite required for durable WikiRuns? Can Pi’s own SQLite session backend or upstream “durable tool/HITL” work replace a host control store?

## Short answers

| Question | Answer |
|---|---|
| Is an atomically committable **Run control true source** required? | **Yes** (commands, gates, attempt CAS, lineage, events, effects). |
| Must that store be SQLite? | **No** as architecture; **yes as recommended localhost implementation**. |
| Is Pi Session SQLite (`#6594` / `pi-storage-sqlite-node`) that control store? | **No** — session entries/branches only. |
| Can unmerged/closed Pi durable-tool issues replace WikiRuns? | **No** — session/toolCall scope only. |
| Postgres / Temporal on current single-owner localhost? | **Out of scope** (product choice). |
| JSONL control journal instead of SQLite? | Possible but usually **harder** (hand-rolled DB duties). |

## Three stores (do not collapse)

```text
workflow.sqlite          → WikiRuns control plane (@okf-wiki/workflow)
Pi Session JSONL         → Operator conversation + Attempt transcripts (/tree here)
  (optional Pi Session SQLite later — still not WikiRuns)
Filesystem artifacts     → sealed snapshot/skill/wiki/candidate bytes
```

## Pi upstream index (GitHub `earendil-works/pi`)

Checked via GitHub API / PR bodies around 2026-07-28–29.

### Session storage (SQLite for conversations, not workflows)

| Ref | State | What it is |
|---|---|---|
| [PR #6594](https://github.com/earendil-works/pi/pull/6594) `feat: sqlite session storage` | **merged** | AgentHarness session backend: `sessions`, `session_entries`, `session_sequences`, `branch_entries`, `session_materialized` |
| [PR #6227](https://github.com/earendil-works/pi/pull/6227) | closed (related lineage) | Earlier sqlite session storage work |
| [PR #7163](https://github.com/earendil-works/pi/pull/7163) `feat: search index sqlite` | open | FTS5 search index on session SQLite; MultiWriter-style sinks |
| Package `@earendil-works/pi-storage-sqlite-node` | in-tree | README: Node `node:sqlite` adapter + **Session** repo/storage — not a workflow DB |

**Implication for OKF:** Operator Session and Attempt transcripts may keep JSONL; adopting Pi Session SQLite later is an optional transcript optimization. **Never** point WikiRuns at this schema or file as the Run authority.

### Execution durability gaps (session store does not fix these)

| Ref | State | What it shows |
|---|---|---|
| [#7053](https://github.com/earendil-works/pi/issues/7053) parallel tool batch orphans | **open** | Sibling tools can finish in UI while results are only persisted after the whole batch settles; kill/abort → “No result provided” and permanent loss of real results |
| `packages/agent/docs/durable-harness.md` | design notes | Semi-durable harness: host rebuilds tools/models; recover from durable **boundaries**; provider streams not resumable; unfinished tools default **interrupted**; retry only if retry-safe |

**Implication:** Even a durable session backend does not make a long `wiki_produce` Promise or in-memory gate a valid Run owner.

### Tool-level durable / HITL discussions (adapter seams at best)

| Ref | State | Scope |
|---|---|---|
| [#5901](https://github.com/earendil-works/pi/issues/5901) Durable HITL tool-call interrupts | **closed** | Persist pending tool call; human approve/edit/reject; resume same `toolCallId` — **tool approval**, not Wiki node graph |
| [#5683](https://github.com/earendil-works/pi/issues/5683) `AgentHarness.resume(toolResults)` | closed (auto-close policy on new contributors) | Stateless server + client-executed tools; rehydrate harness and inject tool results |
| [PR #7111](https://github.com/earendil-works/pi/pull/7111) durable external tool results | **closed, not merged** | `defer: true`, pending marker in session, `submitExternalToolResult`, idempotent duplicate submit — **explicitly limited** to session/tool-call/tool-result model |
| [#5998](https://github.com/earendil-works/pi/issues/5998) `terminate` on blocked tool calls | open | Clean turn end when `beforeToolCall` blocks — policy, not workflow |

**Implication:** If Pi later ships deferred external tools or tool-call HITL, OKF may use them as **thin Attempt/UI seams**. They still do not provide:

- `RetryFailedNode` / `RerunNode` + input digest + downstream invalidation  
- durable plan/publication gates with payload digest CAS  
- artifact prepare/seal/commit and publish effect reconcile  
- Run SSE with `Last-Event-ID` over control events  

Do **not** wait on these issues to implement WikiRuns, and do **not** delete `workflow.sqlite` if they land.

### Integration note (local source)

Coding Agent `createAgentSession` accepts synchronous `SessionManager` (JSONL tree). Harness `SessionRepo` (including SQLite) is a lower-level abstraction. They are not interchangeable without an explicit product migration — out of scope for ADR 0035’s first cut.

## Community durable-workflow notes (not Pi-specific)

Full write-up: [`.scratch/architecture-review-2026-07-28/community-durable-workflow-research.md`](../../.scratch/architecture-review-2026-07-28/community-durable-workflow-research.md).

| Theme | Takeaway for OKF |
|---|---|
| [Building a Durable Execution Engine with SQLite (HN)](https://news.ycombinator.com/item?id=45992316) | SQLite fits self-contained agents; **not** the only store; side effects still need idempotency |
| [Absurd Workflows with Postgres (HN)](https://news.ycombinator.com/item?id=45797228) | Durable execution ≈ queue + state; engines do not invent domain rules |
| [Ask HN: HITL workflows](https://news.ycombinator.com/item?id=38957193) | Common pattern: **persist state, next execution on decision** — not a living Promise |
| Temporal / Restate / DBOS | Real value for multi-worker / long timers; **overkill** for current localhost single owner |

Consensus usable for debate: **durable control semantics are required; SQLite is one implementation; no engine removes publish/model side-effect reconciliation.**

## Alternatives matrix (localhost product)

| Option | Control plane? | Use when |
|---|---|---|
| **WikiRuns + `workflow.sqlite`** | Yes | **Default now** — one Server owner, local disk, sealed FS artifacts |
| Append-only control JSONL | Yes if fully engineered | Only if SQLite is forbidden; expect to reimplement fsync, dedupe, cursor, recovery |
| Pi Session JSONL/SQLite only | **No** | Conversation / transcript only |
| Pi deferred tool / HITL interrupt only | **No** | Optional future adapter |
| Postgres control plane | Yes | Multi-host workers, no shared disk, or existing Postgres ops |
| Temporal / Restate / DBOS | Yes (runtime) | Explicit distributed execution / long signal needs |

## Recommendations (frozen with ADR 0035)

1. Keep **`workflow.sqlite`** inside `@okf-wiki/workflow`; no per-table `StoragePort` for a hypothetical swap.  
2. Keep **Pi Session** on JSONL unless a separate decision adopts harness Session SQLite for transcripts only.  
3. Keep **Artifacts** on the filesystem; DB stores digests and paths.  
4. Treat Pi `#6594` / `#7163` as session-search/resume improvements, not Run control.  
5. Treat `#7053`, `#5901`, `#7111`, durable-harness notes as confirmation that **the host owns durability boundaries**.  
6. Revisit store choice only when single-owner localhost assumptions break (multi-machine workers, remote artifacts, measured SQLite write contention, or policy ban on `node:sqlite`).

## Source links (package / docs in fixed checkout)

When browsing the local `refs/pi` tree at the design commit:

- `packages/storage/sqlite-node/README.md` — session storage package purpose  
- `packages/agent/docs/durable-harness.md` — harness recovery model  
- `packages/coding-agent/docs/sessions.md` — `/tree`, session tree (conversation, not Run graph)  
