# Pi Extension 契约、开发经验与 Dynamic Workflow 对照

日期：2026-08-17

## 范围与版本

本笔记对照四类材料：

- **Pi 官方扩展契约**：本仓库锁定的 `@earendil-works/pi-coding-agent@0.82.1` 文档（`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`、`packages.md`、`rpc.md`）。公开渲染版见 [pi.dev/docs/latest/extensions](https://pi.dev/docs/latest/extensions) 与 [GitHub extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。
- **官方示例经验**：同版本 `examples/extensions/`，尤其是 `subagent/`、`plan-mode/`、`handoff.ts`、`todo.ts`。示例选择不等于框架强制限制。
- **refs 参考实现**：`refs/pi-dynamic-workflows`（`@quintinshaw/pi-dynamic-workflows@3.5.1`）、`refs/awesome-claude-dynamic-workflows`、`refs/tradingflow`、`refs/pi-llm-wiki`。
- **本仓库**：`packages/wiki-workflows` 的 Pi adapter（`src/extension.ts`）与 host-owned production 模块。

证据分三类：**Pi 契约/实现事实**、**官方示例或第三方实践**、**本仓库推断**。

已有笔记 [pi-extension-streaming-ui-and-memory.md](pi-extension-streaming-ui-and-memory.md) 覆盖流式 `onUpdate`、`setWidget` 频率和内存。本文不重复那些细节，只引用结论。

## 结论

1. **Pi extension 是宿主会话的插件面，不是生产编排语言。** 官方能力是事件、工具、命令、UI、session entry。长任务应自己做 manager / journal / UI，不要指望 Pi 提供 workflow runtime。[官方 extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
2. **Claude Code Dynamic Workflows 和 `pi-dynamic-workflows` 是同一产品形态：模型写 JS 编排脚本，宿主执行 `agent()` / `parallel()`，中间结果进脚本变量而不是主会话。** Wiki 生产不是这个形态。本仓库已经把拓扑、校验、出版、恢复做成 host-owned 模块，Lead 只在固定门禁里做动态选择。[Claude workflows 文档](https://code.claude.com/docs/en/workflows) [pi-dynamic-workflows README](https://github.com/QuintinShaw/pi-dynamic-workflows) [ADR-0001](../adr/0001-isolated-full-generation-runs.md) [ADR-0003](../adr/0003-host-owned-wiki-tool-envelopes.md)
3. **`pi-llm-wiki` 也不是对照对象里的「同类 wiki」。** 它是 Karpathy LLM Wiki：在宿主会话上注册一堆工具，做增量知识库、recall 注入和 guardrail。本仓库是隔离的一次完整生成 + 出版，Published Wiki 只作 provenance。[pi-llm-wiki README](https://github.com/zosmaai/pi-llm-wiki)
4. **值得从 `pi-dynamic-workflows` 学的是 extension 工程，不是它的编排模型。** 尤其是：factory 不启动后台资源、`session_start` 才认 `ctx.cwd`、`/reload` / resume / fork 要 handoff 而不是丢掉 live runtime、进度用长期存活的 custom widget + `requestRender()`、不要把进度刷进 transcript、slash command 一旦注册就不能改 metadata。[extensions.md long-lived resources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) [workflow.ts comments](../../refs/pi-dynamic-workflows/extensions/workflow.ts)
5. **本仓库 extension 目前是薄 adapter。** `/wiki` 命令驱动 host producer；widget 是每次 refresh 替换的字符串行；`session_shutdown` 直接 pause Run。这符合「生产不在 Pi 会话里」的架构，但和成熟 Pi 扩展比，reload/cwd/手后面板这几处还浅。

## 1. Pi 官方扩展契约

### 1.1 加载与分发

| 位置 | 范围 |
| --- | --- |
| `~/.pi/agent/extensions/*.ts` 或 `*/index.ts` | 全局 |
| `.pi/extensions/*.ts` 或 `*/index.ts` | 项目，需 trust 后才加载 |
| `settings.json` 的 `packages` / `extensions` | 显式路径或 pi package |
| `pi -e ./path.ts` | 单次测试；官方不建议把它当 `/reload` 热更新路径 |

TypeScript 由 jiti 直接加载，不必先编译。工厂函数可以是 async；Pi 会在 `session_start`、`resources_discover` 和排队的 `registerProvider` flush 之前 await。[extensions.md Quick Start / Locations / Async factory](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

分享形态是 **pi package**：`package.json` 的 `pi.extensions` / `pi.skills`。`pi install npm:@scope/pkg` 默认 `npm install --omit=dev`，运行时依赖必须在 `dependencies`，不能只放 `devDependencies`。扩展拥有完整系统权限。[packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

本仓库 `packages/wiki-workflows/package.json` 已按这个契约声明 `pi.extensions` 和 `pi.skills`，但 `@earendil-works/pi-*` 仍在 `peerDependencies` / `devDependencies`。作为本地 workspace 包可以工作；若按 `pi install` 分发，peer 解析取决于安装环境。

### 1.2 工厂能做什么

`export default function (pi: ExtensionAPI)` 是唯一入口。契约能力：

- `pi.on(event, handler)`：生命周期、agent、tool、input、compaction、model
- `pi.registerTool` / `setActiveTools`：给当前会话的 LLM 用
- `pi.registerCommand` / `registerShortcut` / `registerFlag`
- `pi.appendEntry` + `registerEntryRenderer`：TUI 可见、不进模型上下文
- `pi.sendMessage` / `sendUserMessage`：进模型上下文
- `ctx.ui`：dialog、notify、setStatus、setWidget、custom component

**官方明确的生命周期顺序**（节选）：extension command 先于 `input`；`input` 先于 skill/template 展开；工具是 `tool_execution_start` → `tool_call`（可 block / 改 input）→ `tool_execution_update*` → `tool_result`（可改结果）→ `tool_execution_end`；最终稳定看 `agent_settled` 而不是 `agent_end`。[extensions.md Lifecycle Overview](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

### 1.3 UI 与模式

| 模式 | `ctx.mode` | `ctx.hasUI` | 含义 |
| --- | --- | --- | --- |
| Interactive | `tui` | true | 完整 TUI |
| RPC | `rpc` | true | dialog/notify/status/widget 走 JSON；`custom()` 不可用 |
| JSON | `json` | false | UI 是 no-op |
| Print | `print` | false | 扩展能跑但不能提问 |

`setStatus` / `setWidget` / `notify` 在 TUI 和 RPC 都可用；`custom()` 和 component factory 必须先判断 `ctx.mode === "tui"`。RPC 的 widget/status 是 fire-and-forget，宿主可以忽略。[extensions.md Mode Behavior](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) [rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

### 1.4 状态该放哪

官方推荐把可分支的工具状态放进 tool result `details`，在 `session_start` 从 `sessionManager.getBranch()` 重建。`appendEntry` 适合 TUI 卡片，不进 LLM。Session 级内存对象在 `/new`、`/resume`、`/fork`、`/reload` 时会随实例一起拆掉。[extensions.md State Management](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

跨会话、跨进程的生产状态 **不属于** `appendEntry`。那是本仓库 `.okf-wiki` ledger 的职责。

## 2. 官方文档和成熟扩展里的开发经验

这些不是 API 保证，但是反复出现的工程约束。

### 2.1 工厂不要启动后台资源

> Extension factories may run in invocations that never start a session. Do not start background resources such as processes, sockets, file watchers, or timers from the factory. Defer … until `session_start` or the command/tool/event that needs the resource. Register an idempotent `session_shutdown` handler.

[extensions.md Long-lived resources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

`pi-dynamic-workflows` 还多踩了一层：工厂里 `sendMessage` 仍是 stub，结果投递必须 `suspend` 到 `session_start` 之后。[workflow.ts](../../refs/pi-dynamic-workflows/extensions/workflow.ts)

### 2.2 工厂 cwd ≠ 会话 cwd

Pi 不把 host session cwd 传进工厂。工厂只能看到 `process.cwd()`（启动目录）。真正项目路径在 `session_start` 的 `ctx.cwd`。`/resume` 到另一个项目时，`process.cwd()` 仍可能停在启动目录。

`pi-dynamic-workflows` 因此把 manager/storage 做成可替换引用，并在 cwd 不一致时 pause 旧项目的 live run，再按 `ctx.cwd` 重建。[workflow.ts comments](../../refs/pi-dynamic-workflows/extensions/workflow.ts)

本仓库 `createWikiExtension` 在 `session_start` 里只缓存 context，真正 cwd 在 `/wiki` handler 里用 `workspaceRoot(active.cwd)` 解析。对「命令驱动、不在工厂里开 Run」是够的；如果以后要在 session 一启动就恢复 widget / 自动 reopen，就要学这套 cwd 对齐。

### 2.3 `/reload`、resume、fork 会换掉整个 extension 实例

`session_shutdown` 的 `reason` 可以是 `quit | reload | new | resume | fork`。成功切换后旧实例先 shutdown，再 load 新实例，再 `session_start`。

官方 footgun：`ctx.newSession({ withSession })` 的回调跑在**旧闭包**里，但旧 `pi` / 旧 `ctx.sessionManager` 已经 stale。只能用 `withSession` 传入的新 ctx，且只能带走纯数据。[extensions.md Session replacement](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) 相关 issue：[pi#3606](https://github.com/earendil-works/pi/issues/3606)

`pi-dynamic-workflows` 用 process-wide handoff slot：reload/new 把 `WorkflowManager` 交给下一代；resume 只在目标 session header 的 cwd 确认同项目时才 handoff；跨项目或 quit 则 pause 到 journal。它甚至不用 `SessionManager.open()` 探 header，只读第一行，避免打开就建目录、改写空文件、加载全文。[sessionFileCwd](../../refs/pi-dynamic-workflows/extensions/workflow.ts)

本仓库 `session_shutdown` 一律 `control("pause")`。对 quit 正确；对 `/reload` 和同项目 resume 偏粗：会把还在跑的生成打成 paused，即使进程没死。

### 2.4 命令一旦注册，metadata 不能换

`pi-dynamic-workflows` 把 saved workflow 的 slash command 推迟到 `session_start`：工厂阶段若按启动目录注册，resume 到另一项目后描述会钉死在源项目上，Pi 不能 unregister。[workflow.ts](../../refs/pi-dynamic-workflows/extensions/workflow.ts)

本仓库只注册一个固定的 `/wiki`，没有这个问题。

### 2.5 进度放 widget/status，不要刷 notify

官方 issue [#3881](https://github.com/earendil-works/pi/issues/3881)（已关闭、未合入的社区 benchmark）：spinner 刷新时 CPU 随 transcript 行数上升。结论是运行进度应放 status/widget，终态再 notify 一条。

`pi-dynamic-workflows` 的 task panel 是 **一次 `setWidget(factory)`**，组件订阅 manager 事件后 `tui.requestRender()`，idle 时 2s timer 也 `unref`。本仓库每次 `refresh` 用字符串行替换 widget（见 `live-surface.ts` + `extension.ts`）。功能正确，但和「替换 keyed widget 会 dispose 旧组件」叠加后，高频 refresh 更贵。细节见前一篇笔记。

### 2.6 事件 handler 是同步关键路径

Extension runner 对每个事件 `await` handler。磁盘事务、网络、全量读 event log 会直接拖住 Pi 事件泵。`session.subscribe()` 的用户 listener 相反：返回的 promise **不等待**，调用方必须自建有界队列。本仓库 `PiSessionObserver` 已按这个模型做 coalesce / lifecycle 分流。[前一篇笔记 §1.1](pi-extension-streaming-ui-and-memory.md)

### 2.7 子代理是示例，不是平台

官方 `examples/extensions/subagent` 用子进程 `pi --mode json`，示例上限约 8 任务 / 4 并发，回传父模型的文本截到 50 KB。这是示例保护参数。[subagent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md)

`pi-dynamic-workflows` 把这个想法做成完整 runtime（16 并发 / 1000 总数、worktree、journal resume、usage）。本仓库不走「宿主模型写脚本再 fan-out」，而是 Lead runtime + 有界 `wiki_delegate`。

### 2.8 社区经验（二手，需降权）

[r/PiCodingAgent](https://www.reddit.com/r/PiCodingAgent/) 把 `pi-dynamic-workflows` 当作 Claude-style workflow 的主流 Pi 移植；也有人提更可定制的替代（如 `pi-extensible-workflows`、`@nicknisi/pi-workflows`）。这些是采用信号，不是契约。第三方扩展必须审查源码后再 `pi install`——官方 packages.md 写明扩展拥有完整系统权限。

## 3. refs 对照

### 3.1 Claude Code Dynamic Workflows

官方文档：[code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows)；发布说明：[2026-05-28](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)、[2026-06-02 harness 文](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)。

形态：

- Claude **当场写**一段 JS，后台执行。
- 原语：`agent()`、`parallel()`、`pipeline()`、`phase()`、`verify()` 一类。
- 中间结果在脚本变量里，不占主会话上下文。
- 发现路径：`~/.claude/workflows/` 或 `./.claude/workflows/`，每个文件变成 `/<name>`。
- 限制：最多约 16 并发、1000 总数；脚本不能直接碰 FS/shell，也没有 `import()`；首次有 plan approval。
- 适用：全库审计、大迁移、对抗验证、loop-until-done。明确不是 Skills / Agent teams 的替代，而是「计划变成代码」。

`refs/awesome-claude-dynamic-workflows` 是社区目录，不是运行时。`refs/tradingflow` 是一个保存下来的多角色辩论脚本：`parallel()` 分析师、顺序辩论、`agent({ schema })` 结构化交接、最后用**固定模板**渲 Markdown/HTML（脚本自己不能写盘，要再派一个 agent 落盘）。

### 3.2 `pi-dynamic-workflows`

自称 Claude-Code-style。安装：`pi install npm:@quintinshaw/pi-dynamic-workflows`。

和 Claude 对齐的部分：

- 同一套 `agent` / `parallel` / `pipeline` / `phase` / `verify` / `judgePanel` 脚本契约
- 中间状态在脚本变量
- 后台跑，主会话继续聊天
- 可保存成 slash command，可嵌套 `workflow(savedName)`
- keyword arming（默认词 `workflow`）+ `/workflows` navigator

它在 Pi 上多做的部分（Claude 宿主已经内置、Pi 没有）：

- 自己实现 `WorkflowManager`、journal resume、甚至 `resumeFromRunId` 后按 call-site 重放
- git worktree isolation
- 真实 token/cost 面板
- `setWidget` live panel + `ctx.ui.custom()` navigator
- `/reload` 跨实例 handoff
- 可执行 capability contract 生成文档，避免 prompt 里堆模型目录

它和本仓库**最深的差别**：编排脚本是模型产物，host 只保证原语和恢复。Wiki 生产的门禁（pin sources、empty Candidate、validation、seal、publish）不能交给模型写的 JS。

### 3.3 `pi-llm-wiki`

另一个 Pi wiki 扩展，产品目标相反：

- 宿主会话注册 13+ 工具（`wiki_recall`、`wiki_ingest`、`wiki_ensure_page` …）
- `before_agent_start` 把 recall 注入 system prompt
- guardrail 拦截对 `raw/**`、`meta/**` 的直接写
- 后台 ingest/embed runtime
- 知识随时间累积，Published 层是「当前相信什么」

本仓库 ADR-0001 拒绝跨 Run 复用拓扑和正文。把 `pi-llm-wiki` 的增量 recall 搬过来，会直接违反隔离生成。

### 3.4 本仓库 wiki-workflows

Pi 只做三件事：

1. 注册 `/wiki`（init / run / status / pause / resume / cancel）
2. 用 `setStatus` + 字符串 `setWidget` 画 live surface；TUI 下 `/wiki status` 再开 overlay
3. 订阅 producer `updates()`，可见事件 `notify`，其余只 refresh widget

生产、恢复、出版全在 TypeScript 模块里。Lead 是独立 Pi session + skill，不是宿主模型写的 workflow 脚本。Skill 文本也写明：host session 不要改 `wiki/`。

## 4. 对照表

| 维度 | Pi 官方契约 | Claude DW / TradingFlow | pi-dynamic-workflows | pi-llm-wiki | open-okf-wiki |
| --- | --- | --- | --- | --- | --- |
| 谁拥有控制流 | 扩展作者 | 模型写的 JS | 模型写的 JS + host 原语 | 宿主会话 + 工具 | **Host 模块**；Lead 只在门禁内选择 |
| 并行单位 | 示例 subagent | `agent()` 子代理 | 同左，最多 1000 | 后台 ingest 任务 | Cluster / 有界 delegate |
| 中间状态 | session branch / appendEntry | 脚本变量 | 脚本变量 + journal | vault 文件 | `run-state.json` + agent records |
| 恢复 | 扩展自己做 | 同会话 resume | journal + 可改脚本重放 | 文件即状态 | snapshot transaction + sidecar |
| 主会话职责 | 聊天 + 扩展 | 写脚本、看 `/workflows` | 同左 | 边聊边 recall/ingest | 触发 `/wiki`，不写 `wiki/` |
| UI | status/widget/custom | 宿主内置面板 | custom widget + navigator | status / 工具结果 | 字符串 widget + overlay |
| `/reload` | 拆实例，扩展自理 | 不适用 | process-wide handoff | 靠文件，reload 丢内存 runtime | shutdown 即 pause |
| 适用问题 | 任何插件 | 宽任务、对抗验证、大扇出 | 同 Claude，但在 Pi 上 | 累积知识库 | **一次完整、可恢复的仓库 Wiki 出版** |

## 5. 本仓库该拿什么、不该拿什么

**拿（extension 工程）：**

- 后台资源只在 `session_start` 或 `/wiki` 真正开跑时启动；shutdown 必须幂等。
- 认 `ctx.cwd`，不要把 `process.cwd()` 当项目根。
- `/reload` / 同项目 resume 考虑 handoff live producer，而不是一律 pause。
- live panel 改成一次挂上的 custom component，内部 `requestRender()`；字符串 widget 只当 RPC/无 TUI 回退。
- 可见进度继续只 notify 生命周期事件，不要把 tool telemetry 打进 transcript。
- 分发时把运行时依赖放进 `dependencies`，并按 packages.md 声明 `pi` key。

**不拿（产品形态）：**

- 不要让宿主模型写 wiki 生产脚本。门禁、WikiSpec、Review、Seal、Publish 必须留在 host。
- 不要学 Claude/`pi-dynamic-workflows` 的「千级子代理 + 脚本 journal」。Wiki 的并发预算和委托语义已经更窄，也更可测试。
- 不要学 `pi-llm-wiki` 的增量 vault / `before_agent_start` recall 注入。那是另一类 wiki。
- 不要把 TradingFlow 式多角色辩论搬进生产主路径。独立 review 已经是固定门禁，不是脚本里的 `verify()`。

**本仓库推断（需实现时再验证）：**

当前「薄 adapter + 深 production 模块」比再包一层 workflow 语言更贴 ADR。和 refs 的差距主要在 Pi 会话生命周期和 live UI 接法，不在编排模型。
