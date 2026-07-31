# Anthropic / OpenAI Workflow 与 Handoff 研究

> 研究日期：2026-07-30  
> 范围：Anthropic 与 OpenAI/Codex 的一手资料；用于判断 GitHub #10--#15 是否应由动态 workflow 解决。不是 ADR，也不改变当前实现。

## 结论

这些 issue 不能归为单一的“workflow 过于僵硬”。

- **#10、#12** 是 evaluator -> repair 的信息契约不完整：首轮已知的 blocking defects 被截断或被 prompt 要求少报。动态调度只会让不完整信息沿更多路径传播。
- **#11** 是固定停止条件缺少恢复分支：预算仍必须由 Host 确定，但耗尽后的动作应是策略驱动的 durable operator gate，而非隐式失败。
- **#13、#14** 是审计/观测数据被 live-tail 投影覆盖或截断；这与模型上下文压缩不同。动态 workflow 会更需要完整的耐久 trace，不能以此为代价。
- **#15** 是完整日志的阅读体验问题，独立于 orchestration。

因此建议采取**固定控制面 + 有界动态语义回路**：Host 固定冻结输入、schema 校验、artifact lineage、预算上限、状态转换、gate、发布和 append-only audit；模型只在已授权的节点决定如何细分研究、是否还需证据、哪些 defect 进入本轮定向修复、哪些 review lens 需要复核。

```text
deterministic Run / Candidate control plane
  -> typed, immutable artifacts and complete audit trail
  -> bounded semantic selector (plan / research / repair / re-review)
  -> Host validates policy, schedules next node or opens gate
```

这不是把现有 DAG 替换成开放式 agent swarm。对于 Wiki 生成，最终 Writer/Publisher 的 ownership 不应转交给 research worker；动态性应由一个仍受 Host policy 约束的 manager/supervisor 表达。

## 一手资料的共同边界

| 问题 | Anthropic | OpenAI / Codex | 对本项目的含义 |
|---|---|---|---|
| 何时动态 | Anthropic 把预定义 code path 称为 workflow；当无法预知子任务时才使用 orchestrator-workers 或 agent loop。[1] | OpenAI 建议只在职责、工具、指令或 policy 真正不同后才拆 specialist；过早拆分只会增加 prompts、traces 和 approval surfaces。[4] | 不以“更多 agent”解决 #10--#15；在 plan、证据缺口和 repair routing 三处给受限选择权即可。 |
| 谁拥有结果 | Lead agent 动态分工、综合 worker findings；worker 必须有目标、输出格式、工具/来源和边界。[2] | handoff 代表 specialist 接管下一回应；manager-as-tools 代表 manager 保有最终回复，适合 bounded summary/classification。[4] | Root Writer 是 manager；Leaf/Reviewer 返回 typed receipt/defect artifact，不接管 Wiki/发布。 |
| 何为 handoff | Anthropic 的生产研究系统先将计划写入 memory，subagent 报告 findings；还建议把完整 worker output 写入外部 artifact，只回轻量引用，避免“telephone”。[2] | handoff 可携带 structured metadata 或 filtered history；routing 要窄、描述要短而具体。[4] | handoff 不是错误字符串。须包含 schema/version、run/node/attempt、input digest、scope/objective、完整结果 artifact 引用、status、open questions；Host 先验 schema/digest 再 schedule。 |
| 如何处理长上下文 | Anthropic 将 compaction、structured notes、subagent clean context 分用于连续对话、里程碑和可并行的研究；强调先最大化 compaction recall，过度压缩会丢失关键内容。[3] | OpenAI compaction 把继续运行所需 state 带到下个 context window；返回的压缩窗口是模型继续对话的 canonical input。[6] | **模型上下文压缩不等于审计保留。** 可压缩 prompt input，但必须独立保留 secret-free 原始工具/文本 trail 及完整 validation/defect artifacts。 |
| 如何评估和观测 | Anthropic 对非确定路径建议评估结果与离散 checkpoint，而不是要求每步都走预定路径；生产问题依赖 full tracing 来诊断。[2] | OpenAI trace 记录 run、model/tool calls 与 outputs、handoff、guardrail 和 custom spans；trace 先用于调试，再沉淀为 workflow evaluation。[5] | 验证/gate/发布事件和每次 attempt trace 必须是耐久事实；UI tail 只是投影。审查 eval 检查 outcome 和证据，不要求语义 worker 的固定步骤数。 |
| Codex 的补充 | -- | Codex 以从 repo root 到当前目录的分层 `AGENTS.md` 给任务加载 project context，近处规则覆盖远处规则，且总 instruction 有 size cap。[7] | 小、分层、scope-specific instruction 适合给 attempt；它不是证据、缺陷或审计日志的替代物。把动态 worker 的工作产物写成可寻址 artifact，而不是塞进 instructions/history。 |

## 适用到当前 DAG

### 保持确定：不可由模型决定

这些是 correctness/security/recovery 边界，不是“僵硬”的症状：

- freeze 的 source/skill/prior-Wiki snapshot 与 digest；
- attempt/generation identity、artifact sealing、schema validation 和 lineage invalidation；
- maximum fan-out、model/tool/time/cost/repair budget；
- mechanical validation、publication CAS、cancel/retry 状态机；
- gate 的开闭、operator 授权和 `onExhausted` 的可选行为；
- secret-free、append-only attempt audit log 与 retention/size policy。

这与 Anthropic 的结论相符：agent loop 需要环境的 ground truth、checkpoint 和 stopping conditions；动态行为配合 deterministic safeguards，而非替代它们。[1][2]

### 允许动态：只在声明的 envelope 内

1. **Plan/research**：planner 根据 inventory 与已返回 receipts 决定是否切分、追加哪一个缺口调查，或停止；Host 拒绝超 fan-out/budget 的 plan。只在子任务不可以预先可靠预测且相互独立时 fan-out。该条件正是 Anthropic 对 orchestrator-workers 的适用条件；它也警告需要共享大量上下文或相互依赖很强的任务不适合 multi-agent。[1][2]
2. **Repair routing**：每个 candidate 的 complete `MechanicalReport` / `DefectReport` 先由 Host seal，再由 selector 按 path、defect 类别、严重度生成下一次 `RepairRequest`。可以把独立文件簇并行化，但所有 blocking defects 必须可见；selector 不得用“只修八个”作为隐式策略。
3. **Re-review**：repair 之后 Host 重新执行 mechanical checks，并对受影响的 semantic lenses 重跑 review；reviewer 检查 prior blocking defects 已修复且允许报告新 blocker。动态的是哪些 lens/scope 有必要，不是能否绕过 acceptance。
4. **Budget exhaustion**：selector 不能自行增加预算。达到 policy ceiling 后，Host 依据 `onExhausted` 创建 `gate.fix`（continue with a new explicit budget/feedback）、`deny` 或 typed terminal receipt。这把恢复路径变成可审计的产品决定。

## Handoff 的最小契约

将 live progress、模型 context 和 durable evidence 分为三种不同对象：

| 对象 | 内容与上限 | 消费者 | 规则 |
|---|---|---|---|
| Live tail | 小的最近状态/preview | SSE、Run Graph | 可合并、可截断；绝不能成为唯一存储。 |
| Model handoff | scoped objective、简短 summary、artifact refs、必要的 prior defects/notes | 下一个 agent | token budgeted；允许 compaction，但不可从中反解析 canonical facts。 |
| Durable artifact/audit | 完整 `MechanicalReport`、`DefectReport`、receipt、secret-free tool outputs/text、schema/digest | Host、operator、replay/eval | immutable/sealed 或 append-only；显示层按需读取。 |

一个跨节点 receipt 最少要声明：`schemaVersion`、`runId/nodeId/attempt`、`status`、`objective/scope`、冻结 input digests、完整 findings/defects 或其 sealed artifact ref、evidence locations、`openQuestions`、artifact digest。`complete` 但缺 artifact、坏 schema、缺预期 review seat 均应失败或进入明确 partial/error 状态，不能降级成 clean。

这既满足 Anthropic 对清晰 delegation contract 的经验，也避免将长输出经 coordinator 压缩后丢失；OpenAI 的 manager/tool 区分也说明此处应是有界 worker capability，而非所有 worker 接管 workflow。[2][4]

## 对 #10--#15 的处理顺序

| Issue | 根因分类 | 架构动作 | 不应做的事 |
|---|---|---|---|
| #10 | mechanical -> repair handoff 损失 | `validate.pre/final` seal 完整 report；repair 由结构化 issues/path index 消费。 | 增加 repair round 或让 agent 再猜一次。 |
| #11 | fixed budget 无恢复 transition | 统一执行 `onExhausted`，在 deterministic gate 展示完整剩余 defects、预算和可选动作。 | 让模型无上限地自我继续。 |
| #12 | semantic evaluator-optimizer 信息策略错误 | prompt/typed output 要求每个 lens 列出**全部 blocking** defects；candidate repair 后 differential re-review。 | “少量高信号”覆盖 blocker；只跑 final mechanical validation。 |
| #13 | audit trail 被 display ring buffer 覆盖 | durable append-only transcript 与 bounded `AttemptItem` projection 分离；保留 attempt linkage/retention。 | 将最后 20 条 UI items 当作 transcript。 |
| #14 | durable payload 不完整 | 工具 output 与明确 truncation metadata 写入 durable log；模型 prompt 仍只按需取高信号片段。 | 用 2--4 KiB 隐式截断充当 data retention。 |
| #15 | presentation | 在 #13/#14 完整日志之上复用专用 scroller、auto-follow/jump-latest、settled tool collapse。 | 用 virtualization/更大 dialog 掩盖丢失数据。 |

优先实现的不是“dynamic workflow engine”，而是一个 **candidate/evidence contract vertical slice**：完整 report -> sealed artifact -> typed repair request -> candidate -> revalidate/review -> policy/gate。度量其首轮 blocker recall、repair rounds、budget-exhaust rate、artifact bytes、trace completeness 与 publishable-candidate rate；只有在这些指标显示计划/研究/repair 路由本身造成瓶颈时，才扩大动态调度。

## Sources

1. Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), 2024-12-19. Workflow/agent distinction, orchestrator-workers, evaluator-optimizer, ground truth and stopping conditions.
2. Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), 2025-06-13. Dynamic research, delegation contracts, durable memory/artifacts, evaluation and tracing.
3. Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 2025-09-29. Compaction, note-taking, subagent context isolation, and recall-first compaction.
4. OpenAI, [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration), accessed 2026-07-30. Delegated ownership versus agents-as-tools, bounded specialists, metadata/history handoffs.
5. OpenAI, [Integrations and observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability), accessed 2026-07-30. End-to-end trace content and trace-to-eval workflow.
6. OpenAI, [Compaction](https://developers.openai.com/api/docs/guides/compaction), accessed 2026-07-30. Continuation state carried in the canonical compacted context window.
7. OpenAI Codex, [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md), accessed 2026-07-30. Scoped instruction discovery, precedence and context-size limits.
