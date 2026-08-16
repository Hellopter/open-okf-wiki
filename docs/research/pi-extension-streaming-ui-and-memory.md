# Pi Extension 实时渲染、批任务与内存风险研究

日期：2026-08-17

## 范围与版本

本笔记针对当前仓库使用的 `@earendil-works/pi-* 0.82.1`，研究 Pi extension 的事件、流式工具结果、TUI/RPC UI、子代理批处理和资源生命周期。源码链接固定到该版本对应提交 `b4f293684bba718d59cc1157679bcf6157b3a7f5`，避免 `main` 后续变化影响结论。

证据分为三类：

- **Pi 契约/实现事实**：官方文档或固定版本源码直接规定的行为。
- **官方示例经验**：Pi 仓库自带示例的实现选择，不等于框架强制限制。
- **本仓库推断**：把 Pi 契约映射到 wiki-workflows 当前实现后得出的诊断，需用性能观测验证。

## 结论

1. **Pi 不会把工具更新强制延迟到 process 完成。** 工具只有主动调用 `onUpdate(partialResult)` 才会产生 `tool_execution_update`；TUI 收到 start/update/end 后都会立即请求重绘。因此“batch 开始后长时间没有 process，结束后一次出现”更符合上游没有发语义进度、只把完成事件加入 `process`，或仓库自己的持久化/读取/overlay 链路阻塞，而不是 Pi 的完成后批量刷新机制。[工具更新产生路径](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent-loop.ts#L666-L706) [TUI 的 start/update/end 处理](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2997-L3036)
2. **运行态应显示 `activeTools`，完成态才进入 `process`。** Pi 的事件本来就是 start → update* → end；如果 UI 主列表只取 completed process，工具执行期间为空是数据建模问题。应在同一视图中将 active tool 作为 running row，并由 update 刷新摘要，end 后再转为 completed row。[扩展事件文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#tool-events)
3. **`setWidget` 能实时刷新，但不适合无节制高频调用。** 每次替换 keyed widget 都会移除并 dispose 旧组件、创建新组件并请求渲染；TUI 自身只把渲染请求合并到约 16 ms 的最小间隔。应用层仍应按语义变化或约 100–250 ms 合并更新。[widget 实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1901-L1944) [TUI 调度实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/tui/src/tui.ts#L309-L309) [请求合并](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/tui/src/tui.ts#L716-L762)
4. **当前 OOM 风险不是“Pi 必然泄漏”，但有几个明确的无界或乘法项。** `pi.exec()` 把完整 stdout/stderr 累加到字符串，长输出时内存随输出量增长；AgentSession 的 session manager 会把 append-only entries 和索引保留在内存直到 dispose；高频 `onUpdate` 的异步分发 promise 会在工具结束前被保留；并发 session 会放大这些成本。[`pi.exec` 源码](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/exec.ts#L35-L105) [会话内存索引](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/session-manager.ts#L845-L865) [工具 update promise 生命周期](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent-loop.ts#L666-L706)
5. **本仓库已经确认的主要瓶颈位于 Pi 之外。** ledger updates 每 50 ms 全量读取/解析事件历史、overlay 每次更新都 `await inspectAgent`，以及慢消费者队列可临时积压约 2000 个 lifecycle event（估算约 51 MiB），会造成完成前的可见进度被 I/O 和队列拖慢，并形成真实的瞬时内存压力。Pi 的正确接法不能消除这些成本，必须同时增量读取、缓存 agent snapshot、压缩/丢弃可替代的中间 telemetry。

## 1. Pi 的实时事件链

### 1.1 Agent 与 extension 事件顺序

Pi 定义了 `tool_execution_start`、零到多个 `tool_execution_update`、`tool_execution_end`。并行工具的 update/end 可以交错，最终 tool result 回到模型时仍按原始工具调用顺序排列；UI 不应假设列表尾部就是当前唯一运行工具。[官方事件文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#tool-events)

`message_update` 是模型 token/content 的流式事件。若子代理适配器只消费 `message_end` 或最终 assistant message，就会把持续数十秒的生成表现成“完成时才出现”。[官方事件文档：message_update](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#agent-events)

extension runner 对每个事件逐个调用并 `await` handler。一个做磁盘事务、网络请求或重计算的 handler 会直接延长该事件交付时间；高频 telemetry 不应在这个同步路径内串行做昂贵工作。[ExtensionRunner 源码](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/extensions/runner.ts#L788-L820)

AgentSession 会先等待 extension event，然后才向 `session.subscribe()` 的监听者发事件；用户 listener 自身是同步调用，返回的 promise 不会被 AgentSession 等待。因此监听器若要异步持久化，应自己实现有界队列、合并和错误处理，不能用无界 promise chain 代替背压。[事件顺序](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts#L618-L622) [订阅派发](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts#L547-L551)

`agent_end` 表示一次 agent loop 结束，不一定意味着后续 steering/follow-up 已经清空；需要最终稳定状态时应以 `agent_settled` 为准。[官方生命周期文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#agent-events)

### 1.2 工具怎样真正产生流式 UI

自定义工具的 `execute` 第三个参数是 `onUpdate`。工具必须主动传入结构合法的 partial `AgentToolResult`；Pi 不会轮询子进程或推测进度。每次调用都会形成 `tool_execution_update`，TUI 用该 partial result 替换当前工具展示。[自定义工具流式示例](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#streaming-updates) [AgentLoop 实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent-loop.ts#L666-L706)

RPC 中的 `partialResult` 是截至当前的**累计结果**，客户端应替换旧展示，而不是把它当 delta 追加。若每次都携带越来越大的正文，会反复复制/序列化大对象；进度 partial 应只保留短状态、计数和小段 tail。[RPC tool update 文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/rpc.md#tool_execution_update)

Pi 内置 bash 可作为频率和内存策略参考：它约每 100 ms 发一次 update，并使用有界 `OutputAccumulator`；展示只保留尾部 2000 行/50 KB，完整输出溢写临时文件。这个设计说明“实时”不等于逐 chunk 全量刷新。[bash throttle 源码](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/bash.ts#L200-L200) [bash 更新路径](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/bash.ts#L337-L385) [OutputAccumulator](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/output-accumulator.ts#L30-L77)

相反，`pi.exec()` 没有流式 callback，会等进程退出后一次返回，并分别把全部 stdout/stderr 拼成字符串。它适合小型控制命令，不适合 wiki 生成、日志或可能无界输出的长进程。[`pi.exec` 源码](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/exec.ts#L35-L105)

## 2. UI 刷新机制与模式差异

### 2.1 `setStatus`、`setWidget` 与 custom UI

`ctx.ui.setStatus(key, text)` 更新 footer 状态；`setWidget(key, linesOrFactory, options)` 在编辑器上方或下方放置持久区域；传 `undefined` 清除。它们适合短状态和有限行摘要，而非完整事件日志。[官方 UI 文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#status)

TUI 的 `setStatus` 会更新 footer 并请求重绘；`setWidget` 替换同 key 组件时会 dispose 旧组件，随后重新渲染 widget。当前 wiki overlay 若已有长期存活的 custom component，优先更新其内部状态并调用 `tui.requestRender()`；若只使用字符串数组，则需限制刷新频率和行数。[status 实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1833-L1838) [widget 实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1901-L1944)

TUI `requestRender()` 会合并重复请求并受约 16 ms 最小间隔限制，但每轮仍需 render/diff 组件树。因此应用层 100–250 ms 合并对于慢变化的 batch 状态更合适，且与 Pi 内置 bash 的 100 ms 节流一致。[TUI 源码](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/tui/src/tui.ts#L716-L762)

`ctx.hasUI` 在 TUI 和 RPC 均为 true，在 JSON/print 为 false；但 custom component 是 terminal/TUI 特有能力。RPC 只发送 `extension_ui_request`，status/widget 属于 fire-and-forget，宿主客户端可以展示也可以忽略；`custom()` 在 RPC 中不具备同等交互能力。因此 Web UI 必须显式实现 RPC 消息或自己的 SSE/WebSocket 消费端，不能只验证 TUI extension。[模式能力说明](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#ui-availability) [RPC extension UI](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/rpc.md#extension-ui-protocol)

JSON mode 会按事件发生顺序输出 JSONL，包含 `message_update` 和 `tool_execution_update`；SDK 也可直接 subscribe 并输出 message delta。若 JSONL/SSE 层能实时收到，而 widget 不更新，问题在客户端/UI；若这里也延迟，问题在 producer/observer/persistence 更上游。[JSON mode 文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/json.md) [SDK streaming 示例](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/sdk.md#event-subscription)

### 2.2 长 transcript 的性能经验

Pi 官方 issue tracker 中有一个已关闭、未采纳的社区 benchmark：spinner 刷新时 CPU 随 transcript 行数上升，报告值从 5000 行约 2.2% 增至 20000 行约 7.6%，原因归于每 tick 遍历/render/diff 扁平行数组。它不是 API 保证，也不能直接外推到本机，但支持一个工程结论：高频 `notify` 把进度永久堆进 transcript，会同时恶化 UX 和后续重绘成本；运行进度应放 status/widget，终态再发一条通知。[官方 issue #3881](https://github.com/earendil-works/pi/issues/3881)

## 3. 批任务与子代理

Pi 官方 subagent 示例把 parallel 限制为最多 8 个任务、4 并发，并把每个任务返回给父模型的最终文本限制到 50 KB。这些是示例的保护参数，不是 Pi core 的全局限制，wiki-workflows 仍需定义自己的并发和输出预算。[官方 subagent README](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/README.md#parallel-execution)

该示例通过 child `pi --mode json` 读 JSONL，并调用 `onUpdate` 更新所有任务的当前状态；它保留任务 messages/stderr，并在 collapsed renderer 中只显示最近项目。这里的“50 KB”只限制最终送回父模型的文本，不代表内存中完整 task detail 和 stderr 都已被 50 KB 限制。[subagent 源码](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/index.ts#L33-L36) [并发执行](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/index.ts#L584-L624)

对当前 wiki 的直接含义：batch 顶层必须有独立于 completed process 的状态机，至少呈现 queued/running/succeeded/failed/cancelled、当前 active tool、完成数/总数、最后活动时间；子代理 token 流可合并，工具 start/end 和失败事件不能丢。

## 4. 资源与 OOM 风险

| 风险源 | 边界 | 判断 | 依据 |
| --- | --- | --- | --- |
| wiki 慢消费者 lifecycle 队列 | 已观测可积压约 2000 条、约 51 MiB | **高优先级瞬时风险**；并发 batch 可进一步放大 | 本仓库主线实测；Pi 的 session listener 不等待异步返回，调用方必须自建有界交付。[订阅派发源码](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts#L547-L551) |
| ledger 每 50 ms 全量读/parse 历史 | 随 event history 增长，CPU、I/O、短命对象均增长 | **高优先级性能/GC 风险**；不是 Pi 限制 | 本仓库主线代码分析；应改 offset/cursor 增量读取或内存 fan-out + durable checkpoint。 |
| overlay 每 update `await inspectAgent` | 刷新次数 × agent 数/检查成本 | **高优先级延迟放大器** | 本仓库主线代码分析；应缓存 snapshot，只在 agent 集合/状态真正变化时刷新。 |
| `pi.exec()` stdout/stderr | 无显示截断、无流式消费，随总输出增长 | **明确 OOM 风险** | [`exec.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/exec.ts#L35-L105) |
| 内置 bash output | 展示尾部 2000 行/50 KB，完整输出溢写文件 | **相对有界**；仍需清理临时文件和限制并发 | [`output-accumulator.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/output-accumulator.ts#L30-L77) |
| AgentSession / session manager | append-only entries、`Map` 索引在 session 生命周期内保留 | **中风险**；长会话 × 并发 session 相乘 | [`session-manager.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/session-manager.ts#L845-L922) |
| compaction | 缩短送入模型的上下文，但历史仍 append-only | **不能当作进程内存上限** | [compaction 文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/compaction.md) [session entries 实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/session-manager.ts#L1296-L1302) |
| 高频 `onUpdate` | update handler promise 在工具返回前集中等待；累计 partial 还会反复序列化 | **中风险**；频率/对象大小失控时升高 | [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent-loop.ts#L666-L706) |
| 未 dispose 的 session/订阅/widget | listener、资源和组件引用延长生命周期 | **明确泄漏风险** | [资源生命周期文档](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#resource-lifecycle) [AgentSession dispose](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts#L795-L854) |

Pi 要求 extension factory 不应启动长期资源，应在 `session_start` 或首次需要时懒启动，并在 `session_shutdown` 做幂等清理。当前 wiki 应在 shutdown 同时 abort update stream、unsubscribe session listener、停止 timer/child process、清空 status/widget、dispose nested AgentSession；只清 UI 不等于释放后台 producer。[官方资源生命周期](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#resource-lifecycle) [session shutdown 事件](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/extensions.md#session-events)

## 5. 对 wiki-workflows 的修复优先级

### P0：让运行态可见，并解除慢消费者堆积

1. UI 行模型合并 `activeTools` 与 completed `process`：start 立即创建 running row，update 只替换短摘要，end 原地转完成；不要等 completed process 非空才显示。
2. 将 observer → ledger 的高频 progress 变成**有界、可合并**队列：同一 agent 的未消费 telemetry 只保留最新快照；tool start/end、失败、取消、终态作为不可丢的 lifecycle event。队列达到上限时丢弃/覆盖中间 token progress，并记录 dropped/coalesced 计数。
3. ledger follower 改为 offset/cursor 增量读取，避免每 50 ms 全量 parse；进程内优先从 event hub fan-out，文件轮询仅作为跨进程/恢复路径。
4. overlay 不要每个 telemetry 都 `await inspectAgent`。缓存 agent metadata/snapshot，只有身份或配置版本变化时重新 inspect；渲染读取不可变快照。

### P1：限制刷新和对象大小

1. 以 100–250 ms 节流 `message_update`/计数变化，但立即发送 tool start/end、错误、取消和 batch 终态。Pi 内置 bash 的 100 ms 是合理基线。[官方 bash 实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/bash.ts#L200-L200)
2. `partialResult`、telemetry 和 widget snapshot 只含小型累计状态；日志保留固定字节 tail，完整结果写 artifact 文件并只传路径/摘要。
3. 进度使用 widget/status，避免每次 `notify` 生成永久 transcript 行；每个 batch 只在启动、异常和终态发送通知。
4. 给 batch 并发、单 task 输出、单 session entries、event queue bytes 和 artifact 大小设置显式预算。并发控制必须按**内存预算**而不只是任务数。

### P2：验证与回归指标

至少记录以下指标，才能区分“producer 没发”和“consumer 太慢”：

- `source_event_at → observer_received_at → ledger_committed_at → stream_yielded_at → widget_render_requested_at` 各阶段延迟；
- 每类事件 received/coalesced/dropped、队列条数与估算 bytes、高水位；
- ledger 文件 bytes/事件数、每次读取与 parse 时长；
- `process.memoryUsage()` 的 rss、heapUsed、external、arrayBuffers，按 batch/task/session 数关联；
- active sessions/subscriptions/timers/child processes 数量，shutdown 后应回到基线；
- 一次 30–60 分钟压力测试：并发达到配置上限、每 task 持续流式输出，验证 heap 高水位最终回落而非随历史单调增长。

建议验收标准：tool start 后一个 UI 刷新周期内出现 running row；正常负载下 P95 事件到 UI 延迟小于 500 ms；中间 progress 被合并时 start/end/错误零丢失；长测结束并完成 GC 稳定窗口后，rss/heap 不随已完成 batch 数持续线性增长。
