# Wiki 生成 Workflow 的全栈与 Pi Runtime 架构建议

> Research note only. Not an ADR. This document judges the current implementation by ownership, recoverability, data flow, and usability rather than treating existing ADR text or a minimal diff as a constraint.

**研究日期：** 2026-07-30
**范围：** WikiRuns control plane、Pi Operator Session、Pi-backed Attempt、HITL、retry/rerun/cancel、Run/Session SSE、React workspace、context compaction。
**前置诊断：** [当前 Wiki 生成 Workflow 分析与优化建议](./current-wiki-workflow-optimization-2026-07-29.md)
**外部材料：** [Drive 原始材料分析](./drive-wiki-workflow-source-analysis-2026-07-29.md)、Rahul Garg 的 [The Orchestrator's Tax](https://martinfowler.com/articles/orchestrator-tax.html)
**Pi 版本：** `@earendil-works/pi-coding-agent@0.81.1`，由 [`packages/agent/package.json`](../../packages/agent/package.json) 固定。

---

## 结论

这套产品不应推倒重写为 Pi session、通用 workflow engine、知识图谱或 WebSocket 应用。现有 `WikiRuns` 的 durable control plane 是正确的：Run、Node、Attempt、Gate、Artifact、Effect 和可回放 Run SSE 应继续由 SQLite 负责；Pi 只应执行一个可丢弃的 Attempt。

真正需要重构的是两个失真的执行边界：

1. **Artifact/context boundary。** DAG 已经把 Leaf、Domain、Writer 连起来，但 Attempt workdir 只挂载 sources 与 skill。Spec、research receipt、defect、candidate wiki 和 operator answer 没有成为显式输入投影，因此“上游成功”不等于“下游拿到语义输入”。
2. **Pi/runtime boundary。** Server、SSE reducer 和 UI 把 `agent_end` 当成终态，然而 Pi 明确只有 `agent_settled` 才表示 retry、compaction、queued continuation 均已结束。`POST prompt` 还以 202 之名等待完整 turn，导致 HTTP、Pi 生命周期和 UI optimistic state 相互混淆。

目标不应是更多 agent、更多审批或更大的上下文窗口，而是：

```text
RunIntent
  -> FrozenRunManifest
  -> WikiSpec
  -> ExecutionPlan
  -> plan gate
  -> evidence work units (cognitive locality)
  -> validated AnalysisReceipt[] -> EvidenceBundle/index
  -> one Writer -> WikiCandidate
  -> deterministic validation + strict DefectReport review
  -> bounded repair -> next candidate
  -> publication gate -> atomic publication
```

Pi 的自动 retry、compaction、tool loop 与 Session JSONL 都应被利用，但不能取代 durable Run state、gate answer artifact、candidate lineage 或 publication reconciliation。

## 1. 当前所有权与断点

### 1.1 应保留的所有权

| 事实 | 当前正确 owner | 结论 |
|---|---|---|
| Operator conversation、工具调用、live model loop、Pi JSONL | Pi `AgentSession` / `SessionManager` | 保留 Pi-native Session，不建第二个消息数据库。 |
| 一个 Wiki Run 的 node/generation/attempt/gate/artifact/effect | `WikiRuns` SQLite | 保留，不用 Pi JSONL 或 Pi SQLite 取代。 |
| freeze、路径约束、sealed tree、mechanical validate、atomic publish | Run Boundary (`@okf-wiki/core`) | 保留 framework-free Core。 |
| Attempt 的模型调用、只读/写入工具权限、Attempt transcript | `@okf-wiki/agent` + Pi | Attempt 是 disposable execution，不是 durable workflow owner。 |
| Run 状态和 gate/retry 观察 | Run SSE，带 snapshot/cursor/replay | 保留独立于 Session SSE 的 Run SSE。 |
| Session 对话观察 | Pi Session SSE，重连用当前 snapshot | 保留无 replay 的 Session SSE；它不是 Run progress channel。 |
| 呈现、URL、局部 command feedback | Web | Web 只投影，不重建 agent lifecycle 或 durable business state。 |

这与 ADR 的正确核心相符，但不是对 ADR 的服从理由。特别是 ADR 0035 的“Pi 只是一段可丢弃 Attempt”仍是架构上最强的分界；它的 `Definition v1` 固定拓扑不是不能改变的产品边界。

### 1.2 控制图有边，语义数据没有交接

`definition-v1.ts` 建立了 `Leaf -> Domain -> Writer` 边，且 `artifacts.ts` 会在 claim 时冻结上游 Artifact。但 [`materialize.ts`](../../packages/agent/src/runtime/attempt/materialize.ts) 只复制 `sources/` 和 `skill/`；它不会把 sealed `spec`、receipt、`wiki_tree`、`defects` 或后续 `operator_input` materialize 成 consumer 可读的路径。

结果是：

- Leaf/Domain handler 写入的 receipt 只是 `{ role, summary, mode }`，没有使用已有 [`AnalysisReceiptSchema`](../../packages/contract/src/receipt.ts) 的 `status`、`scope`、`findings`、`evidence`、`childReceipts`、`openQuestions`。
- Domain 没有读取 Leaf receipt，而是再次探索整个 snapshot。
- Writer 的 [`write-shared.ts`](../../packages/agent/src/runtime/attempt/write-shared.ts) 只显式读 Spec；prompt 虽要求证据，真实 workdir 却没有 receipt projection。
- reviewer 也有 [`DefectReportSchema`](../../packages/contract/src/run.ts)，但当前 seat 输出先被包装为摘要，再由 [`review-reduce.ts`](../../packages/workflow/src/wiki-runs/mechanical/review-reduce.ts) 从 JSON、fenced JSON、关键词或 transcript 文本猜测；空或不结构化输出在一些路径会变成 clean。

这正是 Garg 所说的反模式：已经付出了 delegation/orientation cost，却没有把局部 worker 的可用结论带给综合者。保持 raw transcript 不进入 Writer 是对的；缺的是 typed evidence，不是把 transcript 拼进 prompt。

### 1.3 当前 HITL 是半个契约

`PiAttemptOutcomeSchema` 有 `gate_requested`，`WikiRunAttemptStateSchema` 有 `suspended`，`ResolveGate` 也接受 `operator_input`。但生产流程没有闭环：

- scheduler 遇到 `gate_requested` 直接抛错；
- `GATE_KINDS` 不包含 `operator_input`；
- 没有路径把 Attempt 写成 `suspended`；
- `ResolveGate(operator_input)` 仅创建下一个 generation，answer 只留在 gate detail，没有 seal 成 `operator_input` Artifact，也不会绑定到新 Attempt。

这意味着运行期“需要业务事实/偏好才能继续”的真实场景目前只能失败、改 prompt 或让操作者另开对话，不能算 HITL。

### 1.4 Pi 生命周期被投影错了

Pi 0.81.1 的类型明确写道：`agent_settled` 才表示“没有 automatic retry、compaction 或 queued continuation 会继续运行”。`agent_end` 只是一个 agent loop 结束点；Pi 在此后检查 retry、compaction 和队列。

当前 [`agent-stream.ts`](../../packages/contract/src/agent-stream.ts) 将 `agent_end` 与 `agent_settled` 一同归为 idle，[`project-pi-sse.ts`](../../packages/server/src/project-pi-sse.ts) 也会在两者上清理 active tool。这样会产生短暂但真实的错误 UI：看上去 turn 已结束，Pi 却仍在 retry/compact 或即将执行排队的 follow-up。

当前 server 还在 [`command-dispatch.ts`](../../packages/server/src/agent-session/command-dispatch.ts) 中 `await session.prompt()`，而 route 在 await 后才发送 nominal `202`。这使得：

- HTTP “accepted”实际意味着 turn 已结束；
- client 的 `sending` 随 HTTP 结束而非 Pi runtime 结束；
- 断线、server restart、SSE 和 command response 对同一 turn 给出不同事实。

## 2. 目标端到端模型

### 2.1 不变的 durable 事实

```text
                         Operator Session (Pi JSONL)
                                        |
                                        | StartRun receipt / audit link
                                        v
RunIntent -> FrozenRunManifest -> WikiSpec -> ExecutionPlan
                                      |             |
                                      |             v
                                      |       plan gate (Spec + Plan digest)
                                      |             |
                                      v             v
              immutable sources / skill / prior wiki / policy
                                      |
                                      v
             Evidence work units -> AnalysisReceipt[] -> EvidenceBundle
                                      |                         |
                                      +-------------------------+
                                                                v
                                                        one Writer
                                                                v
                                                         WikiCandidate
                                                                v
                              MechanicalReport + DefectReport[] -> EvaluationRound
                                                                |
                                         repair request ---------+----> next candidate
                                                                v
                                                       publication gate
                                                                v
                                                         atomic publish
```

`RunIntent` 记录 operator objective、focus、generate/refresh、限制和受众；`FrozenRunManifest` 固定 Snapshot Set、Skill Version、Run Boundary policy 与 prior Wiki snapshot；`WikiSpec` 描述要交付什么；`ExecutionPlan` 描述这次怎样执行。不要再让一个 `WikiRunSpec` 同时充当 user intent、内容设计和 scheduler topology。

若旧 Run 需要恢复，保留 Definition v1 的 reader/executor 直到它们终态；新 Run 应通过一个明确 version boundary 使用新 contract。不要让同一 node key 在没有版本化的情况下悄悄改变语义。这个 version boundary 是可恢复性需要，不是 generic workflow framework。

### 2.2 ExecutionPlan 按认知局部性切分

不要把每个 question 机械映射为一个 Leaf，也不要复制文章中的“2-4 agent”经验数值。一个 evidence work unit 的边界应由同一 repo mental model 决定：入口、调用链、模块、测试约定和 source scope 高度重叠的问题应由同一个 worker 做完。

| 信号 | 计划动作 |
|---|---|
| 同一 package、入口与调用链 | 合并为一个 evidence work unit。 |
| 不同 source root 或独立运行时/语言 | 可以并行。 |
| 只需要单一证据范围 | 该 worker 直达 Writer，不强制再加 Domain reducer。 |
| 多个 work unit 需要跨域归约 | 才创建 reducer，并消费 receipts 而非重新搜索源码。 |
| worker source-read overlap 很高 | 作为合并 signal，不是继续 fan-out 的理由。 |
| reviewer lens 独立且 benchmark 显示 unique yield | 并行 reviewer；否则保持一个严格 reviewer。 |

Writer 仍是唯一 Wiki 写者。并行 writer 会引入 shared-tree conflict，却不解决 evidence/context 问题。

## 3. Artifact Plane：固定 NodeContract，而非 DSL

### 3.1 需要的深 Module

在 `WikiRuns` 内部建立一个有限的 `NodeContract` registry。它不是给用户编辑的 workflow language，不产生 runtime graph language，也不需要 `ReceiptStore`、`GraphStore` 或新的持久层；它只是当前有限 node kinds 的单一语义事实。

```ts
type NodeContract = {
  kind: WikiRunNodeKind;
  requiredInputs: readonly InputRequirement[];
  projectInputs: (inputs: SealedArtifactSet) => ProjectionPlan;
  validateOutputs: (outputs: unknown) => ValidatedOutput;
  execution: "pi" | "mechanical" | "gate";
  retry: RetryPolicy;
  rerun: InvalidationPolicy;
  hitl?: HitlPolicy;
};
```

它的 Interface 很小，但应隐藏以下行为：claim 前 role/kind/cardinality/schema 校验、input digest、workdir projection、output seal/validation、retry eligibility、rerun invalidation 和 gate payload binding。这样控制依赖、数据依赖与 context projection 在同一处改变，产生 locality；而不是分散在 definition、artifact binder、handler、prompt 和 UI 中。

每个 node 在 claim 前必须验证 required artifacts。缺 `spec`、缺 required receipt、schema 无效或 role 不兼容应成为明确的 plan/attempt failure，不能凭目录存在或 prompt 约定继续执行。

### 3.2 明确的 Attempt 输入投影

所有输入仍来自 sealed Artifact，且大树仍由 Run Boundary 路径约束。变化是将它们显式 materialize：

```text
attempt/
  inputs/
    intent.json
    manifest.json
    spec.json
    execution-plan.json
    evidence/
      index.json
      receipts/<handle>.json
    defects.json
    operator-input.json
    prior-wiki/                 # read-only when refresh/repair needs it
  sources/<source-id>/          # read-only sealed mount/handle
  skill/                        # read-only
  wiki/                         # Attempt-private candidate output
  analysis/                     # Attempt-private typed outputs
  session.jsonl                 # audit only
```

不是每个 Attempt 都需要所有路径。NodeContract 负责最小必要 projection：

| Consumer | 必须可读 | 不应自动注入 |
|---|---|---|
| Planner | intent、manifest、inventory、sources/skill | prior worker transcript |
| Evidence worker | work-unit、spec relevant slice、sources/skill | 无关 domain receipt |
| Reducer | selected receipt bodies/index | raw worker transcript |
| Writer | intent、spec、plan、EvidenceBundle index、receipt handles、sources/skill、prior candidate（需要时） | 所有 worker JSONL |
| Reviewer | candidate、spec/acceptance、sources/skill、relevant evidence handles | Writer chain-of-thought/transcript |
| Repairer | candidate、defects、mechanical report、relevant evidence | 无关 historical receipts |

source tree 可以在 profiling 后改为共享 sealed read-only mount/handle；当前每个 Attempt recursive copy 的成本是 `O(attempt count x source size)`。这属于性能优化，不能先于 Artifact 语义正确性；小型 JSON projection 可以继续按 Attempt 复制。

### 3.3 复用已有 receipt，而不是发明新格式

Leaf/Domain 应输出并 seal 现有 `AnalysisReceiptSchema`。它已经足以表达 scope、findings、Source Citation evidence、child receipt handles 和不确定性。一个 `EvidenceBundle` 只是控制面根据已验证 receipts 生成的有界 index，不是新的知识库或 second transcript:

```text
EvidenceBundle
  receipt handles + digest + scope + compact finding summary
  evidence locations + confidence/open questions
  selected-body paths for on-demand read
```

Writer 的默认顺序应是：读 intent/spec/plan/index，按 handle 读必要 receipt，再回 source 复核 load-bearing claim；只有 evidence gap 才扩大搜索。这样实现的是受控、可审计的跨 Attempt compression，而不是将 transcript 误当知识传递。

### 3.4 Review 要 fail closed

reviewer 必须通过受控的 typed output 提交 `DefectReportSchema`，并在 Attempt 成功前验证：

- seat id/lens 与 ExecutionPlan 匹配；
- `clean` 与 defects 一致；
- required reviewer 缺失、JSON 不合法或 output 截断时，seat 失败；
- `review.reduce` 只合并已验证 `DefectReport`，不解析 summary/transcript/关键词；
- `reviewRequired` 或 configured seat 缺失时，绝不能归约为 `NO_DEFECTS`。

先运行 deterministic validation，再运行 semantic review；每次 repair 生成新 `WikiCandidate`，都要回到相同的 validation 和适用 lens。当前 `repair.review.N -> validate.final` 的 bypass 不应继续作为最终 architecture。

## 4. Pi Runtime：一个小 Interface 的 SessionRuntime

### 4.1 模块职责

将 server 中 `live-session-registry`、command dispatch、Pi event projection 和部分 active-tool/usage 逻辑收束为一个内部 `SessionRuntime` Module。它不是新的通用 session engine，也不是一层 Port；它是把 Pi 生命周期复杂性藏在一个小 Interface 后面的深 Module。

```ts
type SessionRuntime = {
  submit(message: string, delivery: "prompt" | "steer" | "follow_up"): Promise<AcceptedTurn>;
  cancel(scope: "turn" | "queued" | "compaction"): Promise<void>;
  compact(options?: { mode: "idle" | "stop_and_compact" }): Promise<void>;
  snapshot(): SessionProjection;
  subscribe(listener: (event: SessionProjectionEvent) => void): () => void;
};
```

它拥有：

- Pi preflight、detached prompt task、single-turn admission 与异常归一化；
- `agent_end`、auto retry、compaction、queue update、`agent_settled` 的状态机；
- Pi event 到 Session SSE projection；
- active tool、queue、context phase、completion/error 的 snapshot；
- session abort、queue clear 与 compaction abort 的明确语义。

routes 只做认证、请求 schema 和 `SessionRuntime.submit()` ACK。React 只订阅 snapshot/events。这样一处修正终态，所有 caller 都正确，不需要在每个 hook/panel 补 guard。

### 4.2 正确归一化 Pi 生命周期

| Pi 事件 | SessionRuntime 投影 | 不能做什么 |
|---|---|---|
| `agent_start` | `running` | 不写 durable WikiRun state。 |
| `agent_end` | `between_operations`；保留 turn active | 不置 idle，不清理所有 active chrome。 |
| `auto_retry_start/end` | `retrying` / 恢复运行状态 | 不创建 durable retry Attempt。 |
| `compaction_start/end` | `compacting` / 恢复或 error | 不把 Pi summary 当 Run artifact。 |
| queue update | `queued_steer` / `queued_follow_up` | 不伪装为立即 interrupt。 |
| `agent_settled` | terminal `idle` 或 `error` | 不猜测 Run terminal state。 |

Pi 的语义应被如实暴露：`steer` 会在当前 assistant turn/tool calls 结束、下一次 model call 前注入；`followUp` 只在 agent 原本将停止时执行。它们不是立即停止。真正的中断是 `abort()`；如用户选择取消 queued text，应显式调用 Pi 的 `clearQueue()`，而不是假装 abort 自动清空队列。

### 4.3 HTTP 与 SSE

`POST session command` 应在 Pi preflight/admission 成功后立即返回 `202 { acceptedTurnId }`，随后将 detached prompt promise 的终态投影到 Session SSE。后台 promise 必须被 runtime 捕获并转成 event，不能产生 unhandled rejection。

Session SSE 保持“当前 snapshot + genuine Pi stream，无 replay”；Run SSE 保持“snapshot + cursor + replay”。两者都不该彼此注入 business state。Attempt transcript SSE 作为打开 dialog 时的诊断通道可以继续存在，不需要升级为全局第三条实时总线。

### 4.4 取消的层级

`AgentSession.abort()` 只保证中止当前 agent operation 并等待 idle；Pi 对 compaction 和 queue 有独立控制。因此产品命令必须精确命名：

| 命令 | owner | 效果 |
|---|---|---|
| `abort session turn` | SessionRuntime/Pi | 停止当前 Operator Session turn；Run 不取消。 |
| `clear queued messages` | SessionRuntime/Pi | 删除 steer/follow-up 队列，保留已完成历史。 |
| `abort compaction` | SessionRuntime/Pi | 中止当前 manual/auto compaction。 |
| `cancel_run` | WikiRuns | durable cancellation，withdraw gates、阻止 future claim/commit/effect，abort active Attempt。 |

不要让 Composer 的 Stop Session 同时取消 Wiki Run，也不要让 Stop Run 改写 Operator Session transcript。

## 5. Durable HITL、retry 与 rerun

### 5.1 运行期 operator input 的正确状态机

```text
Pi Attempt running
  -> returns gate_requested(question, context, transcript)
  -> seal transcript + gate payload
  -> Attempt = suspended; Node = waiting; Gate(operator_input) = open
  -> Run = waiting_for_operator

operator answer
  -> seal operator_input Artifact (answer, gate id, actor, parent attempt, digest)
  -> old attempt remains suspended/audit-only
  -> new node generation + new disposable Pi Attempt
  -> bind old frozen inputs + operator_input Artifact
  -> materialize explicit inputs and execute
```

服务重启后不恢复老 Pi worker session。Run 从 durable pause boundary 恢复，新 Attempt 从冻结输入和答案重新开始；这是可恢复的，也避免把不可重放的 in-flight model state 当 product state。

Gate payload 应绑定 question/context、producer attempt、当前 node generation 和 prerequisite input digest。answer artifact 也必须成为 lineage 的一部分；只有这样 rerun、审计和后续 writer 才能判断答案属于哪次事实请求。

Plan、operator-input、fix、publication gate 是有业务意义的决策点。不要为每个 evidence worker 再加 approval。若缺的是一个事实，应请求事实，不应把它编码成更多治理仪式。

### 5.2 四个不可混淆的操作

| 操作 | 输入是否改变 | generation | 何时适用 |
|---|---|---|---|
| Session abort | 不涉及 Run 输入 | 不适用 | 操作者停止当前对话 turn。 |
| `cancel_run` | Run 终止 | 不新建 | 操作者放弃整个 durable Wiki Run。 |
| `retry_failed_node` | 不改变 | 同 generation、同 input digest | transient execution failure，且旧 Attempt 未被下游消费。 |
| `rerun_node` | 可以改变 feedback/model/prompt/operator input/plan | 新 generation，失效实际 downstream lineage | 语义输入或执行决策改变。 |

现有 retry/rerun/cancel 的 CAS、generation 和 effect protection 大体值得保留。新的 NodeContract 只应让其资格规则更清晰：

- Pi provider/session retry：Pi live session 内针对短暂 transport/provider failure；
- durable automatic retry：只读、幂等 evidence work，且分类是明确可恢复的基础设施错误；
- manual retry：完全复用 frozen digest；
- candidate repair：不是 retry，是新的 candidate/evaluation round；
- capacity、budget、schema/semantic defect、publication conflict：不要盲 retry，必须明确 stop reason、replan、repair 或 operator action。

Writer、Repairer、Publish 不应因为“再试一次也许好”获得自动重试。重试只有在相同输入下可能恢复运行错误时才有意义。

## 6. Context compaction：三种不同的问题

### 6.1 不要混淆 Pi compaction 与跨 Attempt 压缩

| 层 | 目的 | 真相来源 | 产物 |
|---|---|---|---|
| Pi Session compaction | 让一个长期 Operator Session 适配 model window | Pi SessionManager | append-only compaction summary + active context entries |
| Artifact projection | 控制不同 Attempt 之间真正需要传递的知识 | sealed Artifact / NodeContract | spec、receipt index、defect subset、candidate |
| UI/audit transcript | 让人复盘完整对话 | Pi JSONL full branch | full timeline + compact marker |

当前 [`context-budget.ts`](../../packages/agent/src/runtime/context-budget.ts) 把 workspace target 映射到 Pi `reserveTokens` 与 `keepRecentTokens`，这部分方向正确。它解决的是单一 Session 的窗口压力，不能替代 evidence selection，也不能让 Writer 安全读取所有 worker transcript。

### 6.2 分开“人看见的历史”和“模型当前看到的上下文”

当前 history projection 使用 `SessionManager.buildContextEntries()`，因此 compaction 后旧消息会从用户可见历史消失。应改成两个 read model：

- **Full branch transcript：** 从 Pi branch/JSONL 投影，包含被 compact 的消息与一个 compaction marker；这是默认聊天历史和审计资料。
- **Active model context inspector：** `buildContextEntries()` 结果，仅用于诊断“本次模型看到什么”，不能冒充聊天历史。

不需要第二个数据库。两种视图都来自 Pi JSONL，只是选择不同 SessionManager projection。

Session SSE 的 context 状态应由 runtime 明确发出：`normal | approaching_target | at_target | compacting | unknown`。context token 数是测量值，不是 UI 可随意归零的计数器；compaction 后只有 Pi 的下一次可靠 usage/snapshot 可以更新数值。手动 compact 默认只在 idle 可用；“stop and compact”必须是独立、明确的 destructive turn action。

## 7. 前端重组：URL、Store、一个 Inspector

### 7.1 选择事实，而非从聊天反推

当前 `AgentWorkspacePage` 由 messages、recent runs 和 live hint 推导 `activeRunId`，再将 live snapshot 回写成推导输入。多 Run、历史 receipt、列表延迟或 terminal transition 时会出现选择抖动。

URL 应显式拥有：

```text
/w/:workspaceId?sessionId=<id>&run=<runId>&attempt=<attemptId>
```

- 新 `wiki_produce` receipt 只导航/更新 `run` 参数；它不能成为后续控制事实。
- workspace-scoped `WikiRunStore` 只订阅 URL 指定的 Run，并用现有 native `EventSource` 与 `useSyncExternalStore` 提供 snapshot。
- `attempt` 决定 inspector/dialog 选择，不能由每个 panel 维护一份。
- URL 不应继续携带 `rootPath`；它是 server-resolved Workspace data，不是 UI routing identity。

不需要 Redux、React Query 强制迁移、WebSocket 或多条同 Run SSE。现有 `useWikiRun` 的 epoch/late-frame 防护值得复用；`useSessionAgent` 应增加同等 identity epoch，防止切换 Session 后旧 SSE/command response 写进新页面。

### 7.2 一个 shell-owned Inspector 与统一 command state

当前 Gate Panel 与 Context Panel 都能创建 Run inspector，cancel、gate resolve、retry/rerun 又各自保存 pending/error。应改为：

- shell 持有一个 Inspector，URL 控制打开的 run/attempt；
- 一个 resource/action-keyed command state，例如 `run:<id>:cancel`、`gate:<id>:resolve`、`node:<id>:retry`；
- HTTP response 只代表 command accepted/rejected，Run SSE 才收敛最终 node/gate state；
- attempt transcript 仍是 dialog-scoped GET/SSE，不扩大成另一个全局 store。

Composer 在 Pi 正在工作时应能选择“追加指令”模式：`steer` 与 `follow_up` 显示为排队语义，不能写成“立即中断”。正常 prompt 仍只允许 idle；abort 是独立图标动作。这样不会把一个运行中的 Wiki Run 错误地锁住 Operator composer。

## 8. 外部材料如何影响此设计

Drive PDF 的可靠结论是：先使用可检查的 workflow，只在质量可测改善时增加自治；将 evaluator-optimizer 做成有停止条件的闭环；并发只用于独立工作；shared typed state 优于复制会话。它不证明必须有知识图谱、固定五类节点或某个 agent 数量。

Garg 的文章更适合作为 context-flow test：

| 文章观察 | 本项目的工程含义 |
|---|---|
| token 一次性消耗，context 会影响之后每次判断 | worker transcript 留在 worker/audit；Writer 只获有界 receipt。 |
| cognitive locality 决定合理并行 | ExecutionPlan 按 repo mental model 分组，不按 question 数量 fan-out。 |
| agent 数不是通用常数 | 由 inventory、预算和 benchmark 决定 scouts/workers/review lenses。 |
| 缺一个事实时补事实，不要加治理 | 只保留有业务语义的 plan/operator-input/fix/publication gates。 |

文章是一次 Claude Code session 的探索性复盘，不是受控实验。`2-4 agents`、`5+` 等数值不能成为产品默认值。为此必须记录 metrics，而不是凭感觉调 agent 数：tokens/cost/latency、source-read overlap、receipt bytes、Writer fallback search、reviewer unique defect yield、compaction frequency、gate intervention、retry stop reason 和 publishable candidate rate。

## 9. 迁移顺序与验证

### Phase 0：先增加观察，冻结比较基线

- 按 Attempt 记录 role/model、input/output/cache tokens、cost、queue/active wall time、tool calls、context projection bytes、failure/stop reason。
- 为 source overlap、receipt size、Writer 回源搜索和 reviewer unique defect 增加 run metrics。
- 用相同 Snapshot Set、model、rubric 运行 baseline；不能先把默认 agent 数量翻倍再声称质量提高。

### Phase 1：修 Pi lifecycle，不改 Wiki 语义

- 引入内部 `SessionRuntime`，让 `agent_settled` 成为 Session turn terminal。
- `POST prompt` 在 admission 后 ACK，后台执行和错误通过 Session SSE 投影。
- 明确 abort/queue/compaction command，增加 Session identity epoch。
- 将 full transcript 与 active model context 分开；context phase 进入 SSE。

### Phase 2：一个 evidence-to-writer vertical slice

- 实现有限 NodeContract registry 与 deterministic input projection。
- Leaf 产出并验证完整 `AnalysisReceiptSchema`。
- Writer 消费 `EvidenceBundle` index 和 selected receipt；证明 transcript 没有进入其 inputs。
- 将 work unit 由 question fan-out 改为 cognitive-locality plan；单 cluster 不强制 reducer。

### Phase 3：完成 durable operator-input

- scheduler 实现 `gate_requested -> suspended/waiting/open gate`；
- answer seal 成 `operator_input` Artifact，创建新 Attempt/generation 并绑定旧冻结输入；
- Web 加 answer UI，且明确不恢复旧 Pi worker；
- 在 restart、duplicate resolve、cancel during wait、rerun after answer 下验证 CAS/invalidation。

### Phase 4：重建 candidate evaluation

- reviewer typed `DefectReport` output，移除 summary/transcript parsing 和 zero-seat clean；
- 创建 candidate-based `EvaluationRound`，每次 repair 后都重新 validate/review；
- 将 acceptance 与 evaluation policy 变成执行契约，删除无执行语义字段。

### Phase 5：前端选择与成本自适应

- URL-owned run/attempt 和 one Inspector；共享 command state；
- inventory/benchmark 驱动 worker/reviewer 数量；
- profiling 证明需要后才把 source copy 替换为共享 read-only sealed tree。

### 必须通过的测试矩阵

| 场景 | 必须证明 |
|---|---|
| `agent_end` 后 retry/compaction/queued continuation | UI 不提前 idle；只有 `agent_settled` terminal。 |
| detached prompt | 202 在 admission 后返回，SSE 完整表达执行/失败/settled。 |
| Session switch | 旧 SSE/command response 不能污染新 Session。 |
| Leaf -> Domain/Writer | 消费精确 receipt digest；缺失/坏 schema 在 claim 前失败。 |
| transcript containment | Writer/Reviewer input 中不存在 raw worker JSONL。 |
| operator input | suspend、restart、answer、new Attempt、cancel 和 duplicate answer 均有正确 lineage。 |
| retry | 完全复用同 generation/input digest；反馈或 model change 被拒绝并要求 rerun。 |
| rerun | generation 增加，实际 downstream/gate/effect 按 lineage invalidated。 |
| malformed/missing reviewer | 从不变成 clean。 |
| repair | 每个新 candidate 都通过 deterministic validation 和配置的 semantic review。 |
| refresh | prior Wiki snapshot 被冻结，未受影响页面不被空白重建。 |
| UI Run selection | 多 Run/terminal/list-lag 下 URL 指定的 Run 始终是唯一订阅目标。 |

## 10. ADR 对照与明确取舍

| 现有文本 | 架构判断 | 处理 |
|---|---|---|
| ADR 0035：durable WikiRuns、immutable artifacts、独立 Run SSE | 正确 | 保留并加强。 |
| ADR 0035：Definition v1 的固定拓扑 | 不足以表达 typed input projection、operator input 与 candidate rounds | 新 Run 用显式 versioned execution contract；不要被旧拓扑锁死。 |
| ADR 0030：Pi 负责 Session/tool loop、child session 可用 | 正确的平台选择 | 使用 Pi retry/compaction/queues；child count 不从 ADR 推导。 |
| ADR 0031：Web 是投影，不是第二 runtime | 正确 | URL/store 只选择和投影 durable Run/Session facts。 |
| ADR 0034：避免 generic engine / 虚假 ports | 正确 | NodeContract registry 与 SessionRuntime 是内部深 Modules，不引入 DSL、store ports 或 framework。 |

最终建议不是“在现有 handler 上补几个 if”，也不是为了形式上符合旧 ADR 而保存错误抽象。应保留已经证明可靠的 Run Control 和 Run Boundary，替换语义输入、Pi runtime 和 UI selection 的浅层拼接。完成后，系统才能用框架能力处理 live agent loop，同时用产品自己的 durable artifacts、generations、gates 和 evaluation lineage 处理真正需要恢复与审计的 Wiki 工作。
