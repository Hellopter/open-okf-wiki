# 当前 Wiki 生成 Workflow 分析与优化建议

> Current-state research only. Not an ADR. The recommendations below are not constrained by existing ADR decisions.

**研究日期：** 2026-07-29
**范围：** 当前 `freeze -> publish` 实现、Google Drive 材料及其可核验的一手来源、Rahul Garg 的 [The Orchestrator's Tax](https://martinfowler.com/articles/orchestrator-tax.html)
**Drive 材料核验：** [drive-wiki-workflow-source-analysis-2026-07-29.md](./drive-wiki-workflow-source-analysis-2026-07-29.md)
**全栈补充：** [wiki-workflow-fullstack-pi-architecture-2026-07-30.md](./wiki-workflow-fullstack-pi-architecture-2026-07-30.md) 聚焦 Pi runtime、前端投影、HITL/retry 与 context compaction
**历史对照：** [wiki-generation-optimization-2026-07.md](./wiki-generation-optimization-2026-07.md) 记录的是 2026-07-23 的旧实现，不能直接当作当前诊断

---

## 结论

当前系统已经有一套强度较高的耐久控制面：冻结输入、sealed artifacts、attempt lineage、generation/rerun、人工 gates、独立 repair budget、恢复以及带 baseline/CAS 的发布流程都已存在。

主要问题不是缺少更多 graph 或更多 agent，而是：

> **控制图已经存在，但 Spec、focus、evidence、defect 和 prior wiki 等语义数据没有可靠地沿图流动；review -> repair 也没有形成 evaluator-optimizer 闭环。**

因此，下一轮优化应先打通现有节点之间的类型化交接，并删除或落实没有执行语义的配置。现在不应引入知识图谱数据库、开放式多 agent 对话或多 writer。

结合 Garg 的 “orchestrator tax” 视角，当前问题还可以说得更精确：Leaf/Domain 已经支付了重复读取、重建 repo mental model 和调度的成本，但它们的 bounded findings 没有交给 Writer，所以没有替 Writer 隔离探索噪声、减少工作记忆负担。**这是只付 delegation tax、没有得到 context-isolation return。**

建议的目标架构是：

```text
StartRun(objective, mode)
  -> freeze sources + skill + prior published wiki
  -> deterministic inventory/router
  -> [only when justified] planning scouts
  -> planner submits WikiSpec
  -> host compiles feasible ExecutionPlan
  -> plan gate binds Spec + Plan
  -> [only when justified] typed evidence workers
       leaf receipt -> optional domain reduction -> receipt index
  -> one writer consumes Spec + Plan + receipts + prior wiki
  -> candidate-based EvaluationRound
       deterministic Spec-aware validation
       strict structured semantic review
       bounded targeted repair -> next candidate -> re-evaluate
  -> publication candidate -> gate -> atomic publish
```

这里的 `graph` 仍然是现有 SQLite/artifact DAG。先让现有边承载真实数据，再讨论新的存储模型。

---

## 1. 当前 Workflow

### 1.1 实际链路

```text
wiki_produce
  -> StartRun
  -> freeze
       - repository snapshot set
       - producer skill
  -> plan
       - default: 2 plan scouts
       - 1 planner synthesizes WikiRunSpec
  -> gate.plan
  -> research.leaf.*
  -> research.domain.*
  -> write.root
  -> validate.pre
  -> review.seat.{grounding,coverage,consistency}
  -> review.reduce
  -> gate.fix
       - pass
       - repair.review.N -> validate.final
       - revise gate only
       - deny
  -> validate.final
  -> prepare.publication
  -> gate.publication
  -> publish
```

拓扑入口在 `packages/workflow/src/definition-v1.ts:54-204`。默认值是 2 个 plan scouts、3 个 reviewers，见 `packages/contract/src/workspace.ts:195-248`。

### 1.2 已经做对的部分

| 能力 | 当前实现价值 |
|---|---|
| Frozen inputs | 每次 Run 固定 repository snapshot 和 producer skill，避免 live source 在执行中漂移 |
| Sealed artifact lineage | `attempt_inputs`、`node_outputs` 和 digest 把 Attempt 与精确上游产物绑定 |
| Durable DAG | 节点 generation、retry/rerun、lineage invalidation 和恢复机制使长流程可恢复 |
| HITL gates | plan、fix、publication 都是持久化决策，不依赖一次 agent 会话存活 |
| Mechanical validation | frontmatter、citation format/resolve、路径与页面扫描由 host 执行，而不是交给模型猜测 |
| Repair budgets | hard-validate 与 semantic review repair 使用独立预算，避免一种修复耗尽另一种预算 |
| Publication transaction | publication candidate、live baseline、CAS 和原子替换降低发布竞争及崩溃风险 |

`pnpm --filter @okf-wiki/workflow test` 当前 92/92 通过。测试主要证明耐久调度、恢复、gate 和 fixture happy path；它没有消除下文的 live 语义交接盲区。

### 1.3 相比旧研究已经补齐的能力

2026-07-23 的历史研究曾指出 plan、Leaf、multi-lens review、repair、OKF concept frontmatter 和机械 index 等缺口。当前代码中这些结构大多已经存在。因此优化重点不再是“添加这些节点”，而是验证节点是否读取了它们被绑定的输入、是否提交了可校验输出，以及批准的 Spec 是否真的控制执行。

---

## 2. 核心断点：控制面有边，数据面没有交接

### P0-1. Operator focus 在 StartRun 边界丢失

`wiki_produce` 接收并转交 `notes`：

- `packages/agent/src/tools/wiki-produce.ts:19-23`
- `packages/agent/src/tools/wiki-produce.ts:121-125`

但 server adapter 只解构 `commandId` 和 `sessionId`，随后 dispatch 的 strict `start_run` contract 也没有 `notes`：

- `packages/server/src/agent-session/runtime-input.ts:48-60`
- `packages/contract/src/wiki-runs.ts:141-146`

Planner API 本来支持 `operatorNotes`，实际 Attempt handler 未传：

- `packages/agent/src/workflow/phases/plan-phase.ts:69-96`
- `packages/agent/src/runtime/attempt/handlers/plan.ts:26-42`

结果是用户明确说“重点覆盖 X”时，Run 能成功启动，但 planner 看不到重点。这是静默语义丢失，不是 UI 小问题。

### P0-2. Plan revise 不是 revise

Plan gate 的 `revise` 会把 feedback 写进新一代 plan node 的 `detail_json`：

- `packages/workflow/src/wiki-runs/gate-resolve.ts:186-208`

而 `handlePlan` 不读取 node detail，也没有加载上一份 sealed Spec，更没有传入已有的 `priorSpec` / `revisionFeedback` 参数。下一轮实际上从头规划，operator feedback 和已批准前的计划上下文都丢失。

合理的 contract 应是：旧 Spec 作为 sealed input，新 feedback 作为 node detail；planner 只能提交完整的新 Spec，并保留 changelog。

### P0-3. Research artifacts 被绑定，却没有物化给消费者

控制面会把 Leaf/Domain 输出绑定进下游 `attempt_inputs`：

- `packages/workflow/src/wiki-runs/artifacts.ts:157-202`
- `packages/workflow/src/wiki-runs/scheduler.ts:479-550`

但是 Attempt materialization 只复制 `sources/` 和 `skill/`，然后创建一个空 `analysis/`：

- `packages/agent/src/runtime/attempt/materialize.ts:70-86`

后果：

- Domain researcher 看不到 Leaf receipts，只能重新扫描 source；它不是 reducer。
- Writer 看不到 Domain receipts；prompt 虽要求列出 `analysis/`，那里没有这些输入。
- DAG edge 只表达了“等上游完成”，没有实现“消费上游结论”。

当前 receipt 也只有 `{ role, summary, mode }`：

- `packages/agent/src/runtime/attempt/handlers/research.ts:56-60`
- `packages/agent/src/runtime/attempt/handlers/research.ts:114-118`

仓库已经有更完整的 `AnalysisReceiptSchema`，包括 status、scope、source revision、findings、evidence、child receipts 和 open questions：

- `packages/contract/src/receipt.ts:28-42`

不需要再设计一套 receipt；应使用现有 schema，严格校验并让下游按路径消费。

### P0-4. “Refresh” 实际从空 Wiki 开始

Freeze 只封装 source snapshot 和 skill：

- `packages/workflow/src/wiki-runs/freeze.ts:65-100`

初始 `write.root` 只有在带 feedback 的 rerun/repair 情况下才尝试读取 prior `wiki_tree`：

- `packages/workflow/src/wiki-runs/artifacts.ts:266-273`
- `packages/agent/src/runtime/attempt/write-shared.ts:55-65`

因此 `wiki_produce` 文案声称的 refresh 并未把当前 published Wiki 作为输入。正常新 Run 的 writer 从空目录开始，无法可靠保留用户编辑、未变化页面或历史导航。

架构上，refresh 必须是一等运行模式：freeze 把 publication baseline 作为 sealed `prior_wiki_tree`，Writer 以 prior tree 为 staging 起点。后续 source diff 和 page dependency 只负责减少重算范围，不能替代这个正确性基础。

### P0-5. Repair writer 看不到 sealed defects

`repair.review.N` 已绑定 `wiki_tree + defects`：

- `packages/workflow/src/wiki-runs/artifacts.ts:254-263`

但 shared writer 只读取 Spec、Wiki 和一段 node feedback；它不读取 sealed defects，也没有把已有的 `repairDefects` 参数传给 `rootWritePrompt`：

- `packages/agent/src/runtime/attempt/write-shared.ts:34-98`
- `packages/agent/src/prompts/writer.ts:13-43`

于是“fix sealed defects”在控制面成立，实际 writer 只看到泛化指令或人工补充文字。定向修复所需的 code/path/issue/suggestedFix 没进入上下文。

### P0-6. Review 输出解析 fail-open

Reviewer 目前通过自由文本返回 JSON，receipt 只保存 summary：

- `packages/agent/src/runtime/attempt/handlers/review.ts:18-69`

Reducer 的兼容性 heuristics 会把以下情况视为 clean：

- 非空但不可解析、且不含 blocking 关键字的文本；
- 空 seat artifact；
- 完全没有 seat inputs。

证据：

- `packages/workflow/src/wiki-runs/mechanical/review-reduce.ts:88-136`
- `packages/workflow/src/wiki-runs/mechanical/review-reduce.ts:242-251`

这会把工具遗漏、截断、格式漂移和 reviewer 没执行伪装成“没有缺陷”。Reviewer 应像 planner 一样通过 typed submit tool 写 `DefectReportSchema`；缺失、malformed、seat 数不符都应使 review Attempt 失败，而不是 clean。

### P0-7. Repair 后没有 semantic re-review

当前 review repair 路径是：

```text
review.reduce -> repair.review.N -> validate.final
```

代码明确说明 `MVP: skip re-seats`：

- `packages/workflow/src/wiki-runs/repair-schedule.ts:153-170`

这不是完整 evaluator-optimizer loop。机械 validate 只能发现结构与 citation 解析问题，无法判断原 blocking claim 是否真的修复，也无法发现 repair 引入的新事实错误。

`reviewerPrompt` 已支持 `priorBlocking`，但 handler 没传：

- `packages/agent/src/prompts/reviewer.ts:7-18`
- `packages/agent/src/runtime/attempt/handlers/review.ts:29`

完整闭环是 repair 后先 mechanical validate，再重新运行相关 review lenses；先复核上一轮 blocking defects，再检查新增 blocking regression，并受明确的 evaluation policy 限制。

### P0-8. WikiRunSpec 多个字段不是执行契约

Spec 暴露：

- page/domain `critical`
- `reviewRequired`
- `blockingSeverities`
- `maxRepairRounds`
- `maxHardValidateRepairRounds`

见 `packages/contract/src/run.ts:16-49`。

实际行为中：

| Spec 承诺 | 当前执行 |
|---|---|
| critical page | Validator 只要求至少存在一个 Markdown 页面；不读取 Spec page 列表 |
| blocking severities | Fix gate 固定只筛 `severity === "blocking"` |
| reviewRequired | Definition 固定创建 review seats |
| non-critical domain | 仍是 `write.root` 的硬 DAG 依赖；失败后无法完成写入 |
| fan-out limits | Graph builder 对 approved domains/questions 静默 `slice`，sealed Spec 保持原样 |

证据：

- `packages/core/src/validate-wiki.ts:121-164`
- `packages/workflow/src/wiki-runs/attempt-success.ts:189-205`
- `packages/workflow/src/definition-v1.ts:103-163`

这会出现“operator 批准的 Spec”和“实际执行图”不一致。架构原则是：每个字段要么成为 host-enforced contract，要么删除。尤其 fan-out 超限应在 plan gate 前拒绝 Spec，不能静默截断。

### P0-9. 角色模型配置没有完整接通

- Reviewer resolution 支持 `seatIndex` 轮换模型，但 `liveModel` 和 review handler 都不传 seat index，因此所有 seats 取 reviewers[0]。
- Plan phase 支持独立 `scoutModel`，但 plan handler 只解析 planner model，因此 scouts 回退到 planner model。

证据：

- `packages/agent/src/runtime/model/role-model.ts:24-49`
- `packages/agent/src/runtime/attempt/shared.ts:97-104`
- `packages/agent/src/runtime/attempt/handlers/review.ts:27-29`
- `packages/agent/src/workflow/phases/plan-phase.ts:78-83`
- `packages/agent/src/runtime/attempt/handlers/plan.ts:23-42`

这既削弱 reviewer 去相关性，也破坏原本的 planner/worker 成本分层。

---

## 3. 架构根因与重构边界

### 3.1 根因：Topology 不是可执行的数据契约

当前一个节点的真实 contract 分散在至少五处：

| 位置 | 决定什么 |
|---|---|
| `definition-v1.ts` | 节点和无类型的 `from -> to` edge |
| `artifacts.ts` | 哪些上游 artifact role 绑定到 Attempt |
| `materialize.ts` | 哪些已绑定 artifact 真正进入 workspace |
| Attempt handler | 实际读取哪些输入、产出哪些输出 |
| Prompt | 模型被文字要求读取什么、提交什么 |

SQLite edge 只说明“B 等 A 成功”，没有声明“B 必须读取 A 的哪种 artifact、schema 是什么、缺失时如何失败”。因此控制面可以正确等待 Leaf/Domain，运行时却完全忽略它们的 receipt；测试仍然能证明 DAG 正确。

这不是给几个 handler 多传参数就能彻底解决的问题。应建立一份有限、代码内的 `NodeContract` registry，成为当前节点种类的单一事实来源：

```ts
type NodeContract = {
  inputs: Array<{
    role: ArtifactRole;
    artifactKind: WikiRunArtifactKind;
    required: boolean;
    projection: "inline" | "mounted" | "handle" | "audit-only";
  }>;
  outputs: Array<{
    role: ArtifactRole;
    artifactKind: WikiRunArtifactKind;
    schema?: RuntimeSchema;
  }>;
  executor: "agent" | "mechanical" | "gate";
};
```

这不是做一个可扩展 workflow DSL。当前 node kinds 是有限集合，普通 TypeScript record 足够。它应承担四项职责：

1. Graph compiler 在运行前验证 producer output 与 consumer input 匹配；
2. Scheduler 只按 contract 绑定 required/optional artifacts，不再依赖 ambient role heuristics；
3. Attempt workspace builder 统一 projection/mount，不由每个 handler 自己猜路径；
4. Attempt success 校验必需 typed outputs，缺失或 schema 错误就失败。

这样修复的是整类“图上有依赖、runtime 没消费”的问题，而不是当前恰好暴露的 Research receipt 一例。

### 3.2 分离 WikiSpec 与 ExecutionPlan

当前 `WikiRunSpec` 同时混合了两类概念：

- 产品目标：audience、pages、questions、acceptance；
- 物理执行暗示：domains、critical/optional、review policy、repair budgets。

Workspace fan-out caps 又在 graph builder 中二次改变它，最终形成“逻辑计划被批准，物理计划被静默截断”。更合理的边界类似 logical plan / physical plan：

```text
RunIntent
  objective, focus, generate|refresh, operator constraints
        |
        v
RepositoryInventory + planner
        |
        v
WikiSpec                         what to produce
        |
        v
compileExecutionPlan(spec, budgets, capabilities)
        |
        v
ExecutionPlan                    how this run will execute
```

`WikiSpec` 只描述结果和验收；`ExecutionPlan` 描述 evidence work units、cognitive clusters、依赖、required/best-effort、review lenses、role models 和 budgets。Compiler 必须返回完整可执行计划或明确错误，不能 `slice`。Plan gate 的 payload 应绑定两者的 digest，让 operator 看到目标与实际执行摘要。

Plan revise 随之变得清晰：修改 `WikiSpec`，重新 compile 一个新的 `ExecutionPlan`；已完成且仍匹配 digest 的 evidence artifacts 可以复用，不需要从头抹掉。

### 3.3 把 evaluation round 建成领域对象

当前 hard validation、semantic review 和两类 repair 通过特殊 node key、动态 edge 与注释约定拼接。最明显的后果是 review repair 能直接绕过 reviewer。合理模型应围绕 candidate version，而不是围绕某个 repair node 名称：

```text
WikiCandidate vN
  -> MechanicalReport
  -> ReviewSeatReports
  -> MergedEvaluation
       clean        -> publication candidate
       repairable   -> RepairRequest -> WikiCandidate vN+1 -> evaluate again
       exhausted    -> operator/fail
```

一个 `EvaluationRound` 至少持久化：candidate digest、validator report、seat reports、merged defects、previous round、repair request、result 和 stop reason。Mechanical 与 semantic defects 保留不同 provenance 和处理策略，但共享同一 candidate lifecycle；总预算和分类预算由 `EvaluationPolicy` 明确表达。

现有 node generations、sealed artifacts 和 gates 可以作为这个模型的持久化机制，但不应继续用 `repair.review.N -> validate.final` 这种拓扑捷径表达业务语义。

### 3.4 Context projection 是 artifact contract 的一部分

结合 `The Orchestrator's Tax`，artifact 被绑定还不够；必须定义它如何进入 consumer context：

| Artifact | Projection | 原因 |
|---|---|---|
| `RunIntent`、bounded `WikiSpec` | inline | 每次决策都需要，且体积可控 |
| sources、prior wiki | mounted/handle | 大体积，只按需读取 |
| evidence receipt index | inline summary + mounted body | Root 先获得地图，再按需打开证据 |
| defects | inline blocking subset + mounted full report | Repair 聚焦，同时保留完整审计 |
| transcript | audit-only | 永不自动进入 Planner/Writer context |

这使“保护 Writer 工作记忆”成为可测试的系统约束，而不只是 prompt 建议。

### 3.5 保留、重构、删除、延后

| 决策 | 范围 | 理由 |
|---|---|---|
| 保留 | SQLite run/event/effect、freeze、sealed artifacts、generation lineage、publication CAS | 这些机制解决了真实的耐久性和发布一致性问题 |
| 保留 | Research read-only、单 Writer、transcript audit trail、mechanical validators | 权限与写所有权边界合理 |
| 重构 | StartRun -> `RunIntent`、WikiSpec/ExecutionPlan、typed NodeContract、Attempt context projection | 当前语义漂移的根因在这些边界 |
| 重构 | Review/repair 为 candidate-based `EvaluationRound` | 修复 evaluator-optimizer 不闭环和特殊分支累积 |
| 删除 | transcript keyword heuristics、zero-seat clean、silent fan-out slice、无执行语义字段 | 它们制造伪成功或批准/执行不一致 |
| 逐步替换 | ambient artifact role 扫描、各 handler 手写 input loading、每 Attempt 全量 copy | 统一 contract 后这些兼容路径不再需要 |
| 延后 | Knowledge graph、开放式 agent conversation、多 Writer | 当前没有需求或 benchmark 支撑 |

这里不是追求最少改动。判断标准是模块边界能否让控制依赖、数据依赖和 context projection 保持一致。

---

## 4. 经济性与可观测性问题

### P1-1. 固定重型默认链路

默认每个 Run 先执行 2 个 plan scouts，再由 planner 综合；post-plan 固定运行全部 Domain/Leaf，以及 3 个 review seats。对小仓、单入口仓或低歧义任务，这些调用可能只增加相同证据的重复读取。

PDF 与其一手来源支持的原则不是“agent 越多越好”，而是：先用能满足目标的最简单 workflow；只有子任务独立且质量增益可测时才并行。Planning 和开放式 multi-agent 仍是更昂贵、更难预测的模式。

建议默认轻路径：

- deterministic inventory + 1 planner；
- 0 scouts，除非 inventory 显示大仓、多语言、多入口或规划不确定；
- 1 reviewer，除非 benchmark 证明额外 lens 捕获了独特 blocking defect；
- 单 Leaf 直接供 Writer 使用，不再额外运行 Domain reducer；
- 只有互相独立的 evidence scope 才 fan-out。

### P1-2. 当前拆分没有遵循 cognitive locality

Garg 将 `cognitive locality` 定义为：需要同一 mental model 的任务通常应放在一起；按表面任务切得过细，会让多个 agent 独立支付相同的 orientation cost。

当前 Definition 为每个 domain question 创建一个 Leaf，即使这些问题依赖相同入口、相同模块和相同测试约定：

- `packages/workflow/src/definition-v1.ts:103-159`

并且每个 Leaf 都能看到整个 source snapshot。结果可能是多个 Leaf 反复定位同一 manifest、入口和调用链，再由一个看不到 Leaf receipt 的 Domain worker 重新做一次。

路由应按“需要哪套 repo mental model”分组，而不是机械地按 question 数量 fan-out：

- 同一模块、同一调用链、同一测试惯例的问题交给同一个 worker；
- 跨独立 package/source root、或需要独立证据视角时才拆分；
- 单个 cognitive cluster 不再额外增加 reducer；
- overlapping source scope 是合并信号，不是继续 spawn 的信号。

这比设定一个通用的 agent 数量阈值更可靠。

### P1-3. 缺少优化所需的 Run 指标

`attempts` 当前只持久化状态、input digest、错误和开始/结束时间：

- `packages/workflow/src/wiki-runs/schema.ts:61-73`

没有持久化每个 Attempt 的：

- role/profile/model；
- input/output/cache tokens；
- 估算费用；
- provider latency 与 queue/active wall time；
- tool calls / retries；
- reviewer 独特 defect 和 repair recurrence。

Workspace 中虽有 `inputTokensLimit`、`outputTokensLimit`、`totalTokensLimit`、`maxSteps`，Wiki Run handler 主要接入的是 context target、timeout 和 retry；这些总量预算没有形成 Run 级 admission/stop contract。

没有这组数据，就无法回答 2 scouts、3 reviewers 或 Domain reduction 是否值得。第一项经济性工作应是 telemetry，而不是继续加 agent。

### P1-4. 每个 Attempt 递归复制 sources + skill

`materializeInputs` 对每个 Planner、Leaf、Domain、Writer 和 Reviewer Attempt 都递归复制完整 sealed source tree 与 skill：

- `packages/agent/src/runtime/attempt/materialize.ts:62-85`

磁盘和启动成本近似 `O(attempt count x repository size)`。对正是因为仓库大才 fan-out 的场景，这个成本会被同步放大。

优化前先测 copy time/bytes。确认是瓶颈后，优先让 agent tools 读取同一份 sealed read-only tree，并保留 path containment；无需引入新 artifact store。小型 receipt JSON 可以按 Attempt 复制，repository snapshot 不应重复复制。

### P1-5. 应保护 Writer 的工作记忆，而不只是压 token

`The Orchestrator's Tax` 区分了两种成本：token 是一次性支付，留在主线程里的噪声会影响之后每一次决策；更大的 context window 只给噪声更多空间，并不自动提高注意力质量。

映射到本项目，Root Writer 是语义综合者。Evidence workers 的价值不应主要定义为“并行更快”，而应定义为：

> 把搜索尝试、无关文件、失败路径和重复推理留在 worker context，只把 Writer 完成 Spec 所需的 findings、evidence locations、uncertainty 和 open questions 带回来。

当前把完整 worker transcript 留作审计、而不自动注入 Writer，是正确边界；应继续保持。需要补的是 bounded typed receipt，而不是把 transcript 拼进 Root prompt。详情通过 evidence path 按需回源核验。

同理，不应为了修复 delegation 问题再增加 per-worker approval gate。当前 plan/fix/publication gates 已覆盖真正的用户决策；agent 是否 fan-out 应由 deterministic router、预算和 benchmark 控制，避免把每次 spawn 变成新的流程仪式。

---

## 5. 推荐目标架构

### 5.1 端到端模型

```text
StartRun
  -> RunIntent(objective, focus, generate|refresh, constraints)
  -> Freeze
       RepositorySnapshotSet
       ProducerPolicy/Skill
       PriorWikiSnapshot?
       FrozenRunManifest
  -> Deterministic Inventory + Router
  -> [conditional] Plan Scouts
  -> Planner -> WikiSpec
  -> Plan Compiler -> ExecutionPlan
  -> Plan Gate (binds WikiSpec + ExecutionPlan digests)
  -> Evidence Work Units (grouped by cognitive locality)
       -> AnalysisReceipts
       -> optional reductions
       -> EvidenceBundle/Index
  -> Synthesis
       one Writer -> WikiCandidate v1
  -> EvaluationRound v1
       mechanical validation
       semantic review
       -> clean | repairable | exhausted
  -> [repairable] RepairRequest -> WikiCandidate v2 -> EvaluationRound v2
  -> Publication Candidate -> Publication Gate -> CAS Publish
```

Host pipeline 保持可预测；模型负责 repository-specific reasoning，Compiler 和 Run control 负责能力、预算、依赖与停止条件。动态性被限制在 plan content、evidence work units 和 evaluation outcome，不扩散成模型自由改写整个 workflow。

### 5.2 模块边界

| 模块 | 拥有什么 | 不应拥有 |
|---|---|---|
| Run Control | command/event/state、claim/retry/cancel、generation、gate、effect | Prompt、transcript parsing、Wiki 内容判断 |
| Run Boundary | freeze、sealed storage、digest、path/permission policy、prior publication snapshot | Agent routing、review semantics |
| Plan Compiler | Inventory + WikiSpec + capabilities -> ExecutionPlan；feasibility validation | LLM session、SQLite 调度细节 |
| Artifact Plane | NodeContract、input/output validation、context projection、typed accessor | 业务拓扑决策、prompt heuristics |
| Semantic Executors | Planner、Evidence Worker、Writer、Reviewer、Repairer | 直接操作 Run DB、发布目录或 lineage |
| Evaluation | Candidate、reports、defects、round policy、stop reason | Publication side effect |
| Publication | Candidate build、baseline/CAS、atomic apply、recovery | 重新生成或修复 Wiki |

当前 `packages/workflow` 的耐久数据库可以继续承载 Run Control；不要求重写成新框架。重构重点是让 `packages/agent` 通过 Artifact Plane 获得已校验的 typed context，而不是读取散落的 `sealedInputs` 并靠 prompt 约定语义。

### 5.3 Artifact 与 context contract

| Producer | Typed output | Consumer | Projection |
|---|---|---|---|
| StartRun | `RunIntent` | Planner、Compiler、Writer | inline |
| Freeze | `FrozenRunManifest`、sources、prior wiki? | 全流程 | manifest inline；trees mounted |
| Planner | `WikiSpec` | Compiler、Writer、Validator、Reviewer | inline/mounted body |
| Compiler | `ExecutionPlan` | Scheduler、gate、all executors | inline relevant work unit |
| Evidence Worker | `AnalysisReceipt` | Reducer、Writer | index inline；body mounted |
| Reducer | `EvidenceBundle` | Writer | inline summary + handles |
| Writer/Repairer | `WikiCandidate` | Evaluation | mounted |
| Validator | `MechanicalReport` | Evaluation、Repairer | inline failures + mounted full report |
| Reviewer | `DefectReport` | Evaluation、Repairer | inline blocking subset + mounted full report |
| Evaluation | `MergedEvaluation`、`RepairRequest` | Gate、Repairer、next round | inline decision + typed handles |
| Any agent | transcript | Human/UI audit only | audit-only |

每个 consumer 在开始前校验所需 role、schema 和 digest；缺输入就失败。Transcript 不是 agent-to-agent contract，任何业务状态都不能从 JSONL 文本或关键词推断。

Writer 的默认读取顺序也应成为 contract：先读 RunIntent/WikiSpec/ExecutionPlan 和 EvidenceBundle，再按 evidence handles 回源；只有发现 evidence gap 时才扩大搜索。这既保护上下文，又保留最终作者独立核验 load-bearing claims 的能力。

### 5.4 不引入知识图谱

Drive PDF 的 “Graph Stage”、五类节点和 typed edges 是独立汇编者的综合方案，不是 Andrew Ng 或 Anthropic 的结论。目标架构已有 durable control graph 与 typed artifact graph，足以表示：

```text
Intent -> Spec -> ExecutionPlan -> Evidence -> Candidate
       -> EvaluationRound -> Revision -> Publication
```

增量刷新需要的是 page dependency index，而不是通用 ontology：

- published page -> source citations/files；
- page -> Spec questions/domains；
- page -> producing Run/revision；
- prior page -> replacement page/digest。

这些关系可以先放现有 SQLite/JSON。只有产品出现跨 Run claim 查询、冲突证据保留、entity resolution 或 supersession 查询，并且关系数据库已被 benchmark 证明不足时，再评估知识图谱。

---

## 6. 重构路线

### Phase A：建立架构骨架

1. 定义并贯通 `RunIntent`，把 objective/focus/mode 纳入 frozen manifest 和 lineage。
2. 拆分 `WikiSpec` 与 `ExecutionPlan`；实现 deterministic compiler 和 feasibility errors，移除 silent `slice`。
3. 为现有 node kinds 建立有限 `NodeContract` registry；让 binding、workspace projection 和 output validation 从 contract 派生。
4. Gate payload 绑定 Spec + Plan digests；Plan revise 基于 prior Spec 重编译，而不是重新随机规划。

这一阶段允许内部改动跨越 contract/workflow/agent/server，因为端到端边界本来就跨这些包。按文件数压缩 diff 会保留错误抽象。

### Phase B：迁移 Evidence 与 Synthesis vertical slice

1. Leaf/Domain 提交现有 `AnalysisReceiptSchema` 的完整 receipt，删除 `{ role, summary, mode }` 临时形状。
2. Artifact Plane 为 Domain/Writer 构建 `EvidenceBundle` 和 typed accessors；删除各 handler 的 ad hoc input discovery。
3. ExecutionPlan 按 cognitive locality 形成 work units；单 cluster 直达 Writer，多 cluster 才 reduce。
4. Freeze `PriorWikiSnapshot`；Writer 对 generate/refresh 使用不同 candidate initialization。
5. 增加端到端 lineage test，证明 Writer 消费的是指定 receipt digests，而不只是等待上游成功。

### Phase C：重建 Evaluation lifecycle

1. Reviewer 通过 typed submit tool 产生 `DefectReport`；删除 reducer 的 transcript/keyword heuristics 和 zero-seat clean。
2. 引入 candidate-based `EvaluationRound`，统一机械报告、seat reports、merged defects、round result 与 stop reason。
3. Repairer 消费完整 `RepairRequest`；每个新 candidate 必须重新走 validation 和相关 semantic lenses。
4. `reviewRequired`、blocking severities、critical page coverage 和 repair policy 由 WikiSpec/EvaluationPolicy 执行；不支持的字段删除。
5. 迁移完成后删除 `repair.review.N -> validate.final` 的 bypass 和旧兼容路径。

### Phase D：自适应编排与经济性

1. 按 Attempt 持久化 role/model/tokens/cost/latency/tool calls/context projection bytes/stop reason。
2. 记录 workers 之间 source-read overlap、receipt size、Writer fallback search 和 reviewer unique defect yield。
3. Router 基于 inventory、plan uncertainty 和历史 benchmark 决定 scouts、cognitive clusters 与 review lenses。
4. 修正 reviewer seat model 和 scout worker model；角色配置成为 ExecutionPlan 的一部分。
5. 经 profiling 后将完整 source snapshot 改为共享 sealed read-only mounts/handles，移除每 Attempt 全量 copy。

### Phase E：增量 refresh

1. 保存 publication 对应的 source revisions、page digests 和 page/source dependency index。
2. 用 Git diff + citations + Spec dependencies 计算 impacted pages/work units。
3. 只重新执行受影响 evidence/synthesis，但对 candidate 运行全量机械回归和必要 semantic review。
4. 冲突/claim 查询形成真实需求后，再决定是否需要独立图存储。

独立的小缺陷，例如 reviewer `seatIndex` 未传，可以提前修；但不能把这些补丁误当成架构重构已经完成。

---

## 7. 验证与成功指标

### 7.1 架构与端到端契约测试

| 场景 | 必须证明 |
|---|---|
| Produce with notes | Planner transcript/input 可观察到原始 focus |
| Plan compile/revise | Spec 超出能力时明确失败；新 Spec 基于 prior Spec 和 feedback 重编译 |
| NodeContract | producer/consumer role 或 schema 不匹配时，Run 在执行前拒绝计划 |
| Context projection | 大型 trees 不 inline；transcript 永远 audit-only；required artifact 缺失会失败 |
| Leaf -> Domain -> Writer | 每层读取精确上游 receipt；缺失/坏 schema 会失败 |
| Refresh | 未受影响 prior pages 保留，修改页基于 frozen prior tree |
| Malformed reviewer | 绝不能归约为 clean |
| Evaluation round | 每个 repaired candidate 都有完整 validate/review lineage，不能绕过 evaluator |
| Spec enforcement | 缺 critical page、配置的 blocking severity、reviewRequired 和 fan-out cap 与 contract 一致 |
| Role models | 每个 reviewer seat 与 scout 使用预期 profile |

### 7.2 质量指标

- critical Spec page coverage = 100%；
- source citation resolve rate = 100%；
- sampled factual claim grounding precision；
- Spec critical questions answer rate；
- malformed/missing review falsely clean = 0；
- blocking defect repair convergence，以及每轮新增 regression 数；
- refresh 中未受影响页面的保留率和受影响页面更新 recall；
- 同 snapshot 重跑的质量方差。

### 7.3 经济指标

- tokens、费用、wall time / publishable Wiki；
- 各角色 input/output tokens 与 active latency；
- Root peak context；
- worker raw context / receipt bytes，以及 receipt 压缩后关键 evidence 的保真率；
- workers 之间 source read overlap（重复 orientation 的近似指标）；
- Writer 在已有 receipt 后仍重复搜索相同 source scope 的比例；
- 被自动注入 Planner/Writer 的 transcript bytes（目标为 0）；
- 每个 scout/reviewer 捕获的独特有效问题；
- snapshot materialization bytes/time；
- retry、budget exhaustion 和 operator intervention rate。

### 7.4 因果 ablation 顺序

```text
A  one planner + one writer
B  A + deterministic validation
C  B + one strict evaluator/repair loop
D  C + conditional evidence workers
E  D + additional review lenses
F  E + incremental dependency index
```

每次只增加一个机制，在同一 frozen snapshot、模型和 rubric 上比较。只有质量提升稳定且成本在预算内，机制才进入默认路径。

---

## 8. 外部材料的使用边界

### 8.1 Drive 材料

该 PDF 是 2026-07 的未署名独立汇编，并明确声明不隶属 Andrew Ng、未获其背书。可迁移的是经一手材料核验的窄原则：

- 从最简单、可组合、可测量的 workflow 开始；
- Reflection 要分开 critique 与 rewrite，并有停止条件；
- 并行只用于独立子任务或独立评价维度；
- typed artifacts/shared state 优于复制完整会话；
- 增加自治前先建立质量、成本和延迟 baseline。

不能直接用于本项目决策的表述：

- “Graph 是 loop 的必然下一阶段”；
- HumanEval 95.1% 能外推为 Wiki 质量；
- Reflection 普遍带来 10-30% 提升；
- 四种 Andrew Ng pattern 和五种 Anthropic workflow 应全部叠加；
- Day 1 / Week 1 / Month 1 可直接作为项目排期。

详细来源身份、页码和一手核验见 [Drive 原始材料分析](./drive-wiki-workflow-source-analysis-2026-07-29.md)。

### 8.2 The Orchestrator's Tax

[The Orchestrator's Tax](https://martinfowler.com/articles/orchestrator-tax.html) 由 Thoughtworks 的 Rahul Garg 撰写，2026-07-28 发布于 MartinFowler.com。它是一篇基于一次真实 Claude Code session 的探索性经验文章，不是受控实验。作者明确披露：

- 没有真实 per-call token accounting；
- “poll transcript 比四个 subagents 的 duplication tax 更贵”来自 orchestrator 自评，只能视为假设；
- `2-4 agents per wave`、`5+ 先合并` 是针对当时任务和 Claude Sonnet 5 的校准，不是通用常数；
- 关于工作记忆质量的度量仍是开放问题。

因此，本项目应采用文章中可检验的机制，而不是照抄阈值：

| 文章观察 | 当前 Wiki Workflow 映射 | 建议 |
|---|---|---|
| Full transcript polling 会污染主 context | 当前 transcript 主要留在 Attempt，边界方向正确 | 保持 transcript audit-only；下游只读 typed receipt |
| Disposable reasoning 应留在 worker | Writer 当前收不到 research receipts，仍需自己重建理解 | 让 receipt 真正进入 Writer，并按需回源 |
| Cognitive locality 比按任务切分重要 | 每个 question 固定一个 Leaf，scope 可能高度重叠 | 相同 mental model 的问题合并给一个 worker |
| 并发 writer 带来共享树风险 | 当前 research 只读、Wiki 由单 Writer 集中写 | 保留单 Writer，不引入并行写 Wiki |
| 更多 governance 可能只是仪式 | 当前已有三种有业务意义的 gates | 不新增 spawn approval / per-agent gate |
| Worker 需显式获得相关 skill | 每个 Attempt 已物化 skill，prompt 指向具体 reference | 保留显式 skill path，避免把全文复制进 prompt |

文章强化了本报告的主结论：优化目标不是简单减少 agent，也不是简单增加并行，而是让每个 worker 有独特、局部的知识范围，并确保只有值得占据 Writer 注意力的信息穿过 artifact boundary。

---

## 9. 最终建议

这不应落成一组散布在 server adapter、handler 和 prompt 里的最小补丁，也不需要推倒耐久控制面重写。合理的架构动作是：**保留可靠的 Run Control，替换失真的 Semantic Execution boundaries。**

1. 用 `RunIntent -> WikiSpec -> ExecutionPlan` 统一用户目标、逻辑结果和物理执行；
2. 用 finite `NodeContract` 统一 topology、artifact binding、context projection 和 output validation；
3. 用 candidate-based `EvaluationRound` 取代 repair 特殊分支，保证每次修改都回到 evaluator；
4. 用 EvidenceBundle 让 worker 真正保护 Writer context，并按 cognitive locality 决定是否并行；
5. 把 refresh、prior Wiki 和 page/source lineage 作为一等领域概念；
6. 删除 fail-open heuristics、silent slice 和无执行语义字段，而不是继续兼容；
7. 用 benchmark 决定 scouts/reviewers/graph 是否存在，不用固定成熟度叙事决定。

现有 SQLite、sealed artifacts、generations 和 publication CAS 足以承载这次重构，但当前语义执行层本身不值得按原样保留。知识图谱属于有明确跨 Run 查询需求之后的存储选择，不是修复这套架构的替代品。
