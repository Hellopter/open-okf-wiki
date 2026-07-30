# Drive 原始材料分析：从 Loop 到 Graph 对 Repo-to-Wiki Workflow 的可用证据

> Research note only. Not an ADR.

**研究日期：** 2026-07-29
**原始文件：** [Google Drive PDF](https://drive.google.com/file/d/1G33UqJQpul8r28Xjo_9TgVV0RPyEbGxM/view)
**范围：** 只分析该 PDF 及其列出的 Andrew Ng / DeepLearning.AI、Sequoia Capital、Anthropic 一手材料；不以现有 ADR 或当前 workflow 实现为前提。
**标记：** `文档原话` 表示 PDF 明示内容；`一手核验` 表示能在署名方原始材料中确认；`推论` 表示本文针对 repository-to-wiki 的工程判断，不是来源原话。

---

## 结论

这份 PDF 最值得用于 repo-to-wiki 的不是“从 loop 升级到 graph”这条叙事，而是四个更窄、证据更强的原则：

1. **先建立可检查的固定链路，再按已观察到的失败增加自治。** Anthropic 明确建议从简单 prompt、直接 API 和可组合 workflow 开始，只在结果可测地改善时增加复杂度；Andrew Ng 也明确说固定步骤不需要 Planning。[PDF p.4 §III.F；DeepLearning.AI, Planning](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-4-planning/)；[Anthropic, Summary](https://www.anthropic.com/engineering/building-effective-agents#summary)
2. **对 wiki 质量最直接的优化是有界 evaluator-optimizer loop。** 先生成，再按显式 rubric 输出缺陷，再做定向修复；机械校验先于主观评审，每轮保留停止原因并设置上限。[PDF p.2 §II.A；DeepLearning.AI, Reflection](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-2-reflection/)；[Anthropic, Evaluator-optimizer](https://www.anthropic.com/engineering/building-effective-agents#workflow-evaluator-optimizer)
3. **并行化适合证据搜集和互相独立的评审维度，不自动适合多人同时写最终叙事。** 来源支持 sectioning、独立视角和角色分工，但也警告多 agent 质量难预测、相同证据与相同 rubric 会放大同一种错误。[PDF pp.3-4 §II.D/§III.C-D；DeepLearning.AI, Multi-Agent Collaboration](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-5-multi-agent-collaboration/)；[Anthropic, Parallelization](https://www.anthropic.com/engineering/building-effective-agents#workflow-parallelization)
4. **该材料不足以证明 wiki workflow 需要知识图谱。** “Graph Stage”、五类节点和 typed edges 是未署名汇编者的综合判断，不是 Andrew Ng 四模式或 Anthropic 五 workflow 的结论。首选 run-scoped plan、evidence、draft、defect、decision 工件；只有出现跨 run 关系查询、冲突保留、可追溯 supersession 等已测需求时，再比较 graph 与普通文件/数据库。[PDF p.5 §IV.D-F；p.7 Table V；p.8 Appendix E；[Anthropic, Combining patterns](https://www.anthropic.com/engineering/building-effective-agents#combining-and-customizing-these-patterns)

因此，面向 repo-to-wiki 的独立建议是：

```text
frozen repository
  -> survey + page/evidence plan
  -> bounded read-only evidence work (parallel only where independent)
  -> one coherent staging-wiki synthesis
  -> deterministic validation
  -> grounding / coverage / coherence review
  -> bounded targeted repair + full regression validation
  -> publish decision with reason
```

这是本文的 `推论`，不是 PDF 给出的现成产品架构。它刻意不引入 graph、开放式 agent 对话或多 writer；应先由评估证明这些额外机制解决了真实失败。

---

## 1. 原始文件身份与证据权重

### 1.1 可确认元数据

| 字段 | 结论 | 证据 |
|---|---|---|
| Drive 文件名 | `Andrew Ng - 4 agentic steps - "from Loops to Graphs from scartch" .pdf`；文件名自身含 `scartch` 拼写错误 | Drive viewer 标题及下载响应的 `Content-Disposition` |
| 页面标题 | `Andrew Ng — My 4 Steps - From Loop Engineering to Graph Engineering`；上方另有 `Full Course From Scratch` | PDF p.1 |
| 作者 | **未署名。Andrew Ng 是材料主题，不应记录为本 PDF 作者。** | p.1 明示 “Independently compiled ... not affiliated with Andrew Ng and not endorsed”；p.7 又称 “independent synthesis assembled for study” |
| 来源声明 | 基于 Andrew Ng 的公开课程与演讲，例如 DeepLearning.AI，“and others” | PDF p.1 |
| 日期 | 正文只给出 `July 2026`，没有日；Drive 下载对象的 HTTP `Last-Modified` 为 `2026-07-23`，后者只是对象修改时间，不等于出版日期 | PDF p.1；[Drive 下载对象](https://drive.usercontent.google.com/download?id=1G33UqJQpul8r28Xjo_9TgVV0RPyEbGxM&export=download&confirm=t) |
| 版本 | **没有版本号或修订标识** | PDF 正文及 PDF metadata 均无版本字段 |
| 文档类型 | 8 页、A4、IEEE 风格的独立技术综述/学习笔记，含伪代码、表格和附录；不是 Andrew Ng 或 DeepLearning.AI 发布的 course/paper | PDF pp.1-8，尤其 p.1 Abstract、p.7 Acknowledgment & Sources |
| 文件指纹 | SHA-256 `6bfa2f96b21a6222de51eb160a92830623f4168587f1e5b6813b2e8e89d6188a` | 2026-07-29 对 Drive 直链下载件计算 |

PDF 有完整文字层，共约 5,331 词；唯一的位图是 p.1 架构图，已单独检查。图中只有 `User`、`Architect Agent`、`Tech Lead Agent`、`Developer Agent`、`AI Document` 及 handoff/feedback 等边；图注虽称 “typed handoffs”，图本身没有给出类型、schema、存储或执行语义。[PDF p.1 Fig. 1]

### 1.2 可信度限制

| 材料中的表述 | 核验结果 | 使用方式 |
|---|---|---|
| “Andrew Ng proved” GPT-3.5 agent workflow 达到 95.1% | **过度表述。** Andrew Ng 的原文是其团队汇总多个研究团队的 HumanEval 结果，并称 GPT-3.5 在 agent loop 中 “up to 95.1%”；不是 Andrew Ng 亲自完成的受控证明。[PDF p.1 Abstract、p.6 §VI；DeepLearning.AI, Part 1](https://www.deeplearning.ai/the-batch/how-agents-can-improve-llm-performance/) | 只能作为 coding benchmark 的报告值，不能作为 wiki 质量提升证据 |
| Reflection、Tool Use、Planning、Multi-Agent 是 Andrew Ng 的四模式 | **一手确认。** [DeepLearning.AI Part 1](https://www.deeplearning.ai/the-batch/how-agents-can-improve-llm-performance/) 逐项列出四者 | 可作为模式词汇，不代表四者都应采用 |
| Prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer 是 Anthropic 的五 workflow | **一手确认。** Anthropic 同时区分预定义 workflow 与由模型动态控制过程的 agent。[Anthropic, What are agents?](https://www.anthropic.com/engineering/building-effective-agents#what-are-agents) | 可作为选择菜单，不是升级阶梯 |
| Graph 是 loop/chain/network 的自然下一阶段 | **未被所列 Andrew Ng 或 Anthropic 一手材料确认。** 这是汇编者在 §IV 的综合叙事 | 只能作为待验证假设 |
| Reflection 可带来 `10-30%` 质量提升；各阶段分别需 1 天/1 周/1 月 | PDF 没给实验定义、数据集或引用。[PDF pp.5-6 §V/Table III] | 不进入预算、排期或 acceptance criteria |
| 每个失败模式和控制项已经被实证验证 | PDF 多数列表没有逐项对应实验或引文 | 可转成测试假设，不能直接视为保证 |

此外，p.1 右栏已出现 `Who This Note Is For` 和 `Contributions`，p.2 左栏又重复这两节；引用列表只给文献名而无 URL。它适合做主题索引，不适合作为唯一设计依据。

---

## 2. 可迁移机制

### 2.1 Reflection / Evaluator-Optimizer

**文档原话：** Reflection 的必要属性是显式反馈回路和停止规则；最少有 task、current draft、critique、revision decision 四类工件。建议把 critique 与 rewrite 分开，让 evaluator 对 draft/test/source 给出证据，限制迭代次数，并保存停止原因。[PDF p.2 §II.A]

**一手核验：**

- Andrew Ng 描述的是 `生成 -> 批评 -> 带反馈重写`，并建议用单元测试或 web search 为反思提供外部信号；他只说在“a few cases”获得明显改善，没有给通用提升比例。[DeepLearning.AI, Reflection](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-2-reflection/)
- Anthropic 认为 evaluator-optimizer 适用于有清晰评价标准、且迭代改进具有可测价值的任务；是否适用取决于人类反馈能否改善结果，以及模型能否产生这种反馈。[Anthropic, Evaluator-optimizer](https://www.anthropic.com/engineering/building-effective-agents#workflow-evaluator-optimizer)

**对 repo-to-wiki 的推论：**

- 不用一个 “improve this wiki” prompt 同时评审和重写。Reviewer 先返回结构化 defects，例如 `grounding`、`coverage`、`coherence`、`navigation`、`severity`、`evidence`；Writer 只修 blocking defects。
- 在 LLM review 之前先跑确定性检查：页面/schema、引用可解析性、目标文件与行号存在、内部链接、计划页覆盖。机械失败无需消耗 evaluator 判断。
- 每轮修复后重跑全量机械检查和原 rubric，防止修复一个页面时破坏另一处；停止条件是 “无 blocking defect” 或 “达到上限”，二者都记录原因。
- 同模型换 system prompt 只能提供角色分离，不能保证独立性；高风险 grounding 判断应由源码证据或人工抽检兜底。

### 2.2 Tool Use

**文档原话：** Tool Use 用外部搜索、代码执行、数据库和文件操作提供 grounded data 或 deterministic action。列出的失败包括选错工具、参数无效、盲信工具结果和工具过度使用；控制包括 typed schema、参数校验、结果确认和权限边界。[PDF pp.2-3 §II.B]

**一手核验：**

- Andrew Ng 说明工具需要清晰的能力描述和参数定义；工具过多时可先检索当前步骤相关的工具子集。[DeepLearning.AI, Tool Use](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-3-tool-use/)
- Anthropic 建议像设计 HCI 一样设计 agent-computer interface：明确示例、边界、输入格式和 edge cases，并用大量样例观察模型实际犯错；其 SWE-bench agent 甚至通过强制 absolute path 消除了路径使用错误。[Anthropic, Appendix 2](https://www.anthropic.com/engineering/building-effective-agents#appendix-2-prompt-engineering-your-tools)

**对 repo-to-wiki 的推论：**

- Repo 调查工具默认只读；wiki 只允许写 staging 根。工具必须返回规范化路径、读取范围和失败状态，不能只返回一段无法定位来源的文本。
- 搜索与读取应显式暴露截断、二进制文件、符号链接、ignored path、生成文件等结果状态；“tool returned text” 不等于 “claim 已被源码支持”。
- 能由宿主确定性完成的路径校验、引用解析、链接检查和发布操作，不交给模型自由选择。

### 2.3 Planning 与 Prompt Chaining

**文档原话：** Planning 适用于运行前无法经济地确定任务路径的情况；失败模式包括 over-planning、plan-execution gap、级联失败和无限 replan。建议 structured plan、依赖校验、步骤上限、fallback，并在 replan 时保留已成功工作。[PDF p.3 §II.C；p.8 Appendix C]

**一手核验：** Andrew Ng 明确区分两类情况：固定次数的 Reflection 不需要 Planning；只有复杂任务无法预先分解时，才让 agent 动态选择步骤。他同时称 Planning 较不成熟、结果更难预测。[DeepLearning.AI, Planning](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-4-planning/)

Anthropic 对固定链的建议更直接：如果任务能干净地拆成固定子任务，就用 prompt chaining，并在中间放 programmatic gate；只有无法预知子任务时才用 orchestrator-workers。[Anthropic, Prompt chaining](https://www.anthropic.com/engineering/building-effective-agents#workflow-prompt-chaining)；[Anthropic, Orchestrator-workers](https://www.anthropic.com/engineering/building-effective-agents#workflow-orchestrator-workers)

**对 repo-to-wiki 的推论：**

- `snapshot -> survey -> plan -> evidence -> write -> validate -> review -> repair -> publish decision` 可以保持宿主固定；模型只决定 repo 特有的 domains、pages、questions 和 evidence assignments。
- Plan 应是可校验工件而非聊天文字：页面 ID、目标读者/问题、证据范围、依赖、acceptance criteria、状态和预算。执行前拒绝重复 ID、循环依赖、无证据范围和超预算计划。
- Replan 只修改未完成部分，已通过验证的 evidence receipt 或页面不因一次 worker 失败而丢失。

### 2.4 Parallelization 与 Multi-Agent Collaboration

**文档原话：** PDF 区分 parallel sectioning 与 voting，并指出相同模型、近似 prompt 的十次输出不是十个独立判断；多 agent 还可能产生冗余、groupthink、对话膨胀和协调开销。它建议每次 handoff 都有 artifact contract，让 worker 返回结构化工件而不是完整对话。[PDF pp.3-4 §II.D/§III.C-D]

**一手核验：**

- Andrew Ng 认为角色分解能让每次调用聚焦一个子任务，但也明确说 multi-agent 的结果难预测，尤其是 agent 自由互动并获得多个工具时；Reflection 与 Tool Use 更成熟。[DeepLearning.AI, Multi-Agent Collaboration](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-5-multi-agent-collaboration/)
- Anthropic 只在子任务独立、需要多个独立视角或需要不同关注维度时推荐 parallelization；其示例是把 guardrail 与主任务分开，或让不同调用评估不同方面。[Anthropic, Parallelization](https://www.anthropic.com/engineering/building-effective-agents#workflow-parallelization)

**对 repo-to-wiki 的推论：**

- 可以并行：互不重叠的 repo domain 调查、候选源码证据提取、grounding/coverage/coherence 等不同 review lens。
- 不应默认并行：同一页面或同一 wiki 导航叙事的最终写入。多个 writer 的合并成本与一致性风险需先用实验显示值得承担。
- Worker 只返回有界 receipt：scope、claims、source paths/locations、uncertainty、open questions；Root 按需读取，而不是拼接全部 transcript。
- 新增 agent 前必须声明它捕获的独特错误类；如果与已有 agent 使用相同证据、相同 rubric 且没有可测增益，就删除该角色。

### 2.5 Graph / Durable Shared State

**文档原话：** PDF 把 graph 描述为外置共享状态，并提出 `Entity`、`Claim`、`Source`、`Artifact`、`Run` 五类节点，以及 `supports`、`contradicts`、`derived_from`、`supersedes` 等边；同时警告 graph 会同样高效地保存错误，因而需要 schema、canonical identifiers、provenance、conflict representation、confidence calibration 和 review。[PDF p.5 §IV.D-F]

**证据边界：** 这些 schema 与 “Month 1 wire into a graph” 都是汇编者的方案。Andrew Ng 的四篇模式文章和 Anthropic 的五 workflow 文章没有要求知识图谱，也没有验证该 schema。Anthropic 反而强调模式不具规定性，只在结果可测改善时增加复杂度。[Anthropic, Combining patterns](https://www.anthropic.com/engineering/building-effective-agents#combining-and-customizing-these-patterns)

**对 repo-to-wiki 的推论：** 先用最小持久工件即可表达 `plan -> evidence -> page -> defects -> revision -> decision`。只有同时满足下列条件时，才值得评估 graph：

1. 状态必须跨多次 run 保存，而不是只服务一次生成；
2. 产品需要按关系查询 claim/source/page/run，而非按已知路径读取工件；
3. 冲突证据和 supersession 是实际用户需求；
4. 简单文件或关系数据库已在可重复 benchmark 上形成检索、上下文或审计瓶颈；
5. 团队能承担 entity resolution、迁移、访问控制和错误传播的额外校验。

在这些 trigger 出现前，graph 是待证明的复杂度，不是 workflow 优化的前置条件。

---

## 3. 失败模式与最小控制

| 失败模式 | 来源中的描述 | Repo-to-wiki 最小控制（推论） | 最小可观测信号 |
|---|---|---|---|
| Self-confirmation | Critic 重复 generator 的假设；角色分离不保证独立 [PDF p.2 §II.A] | Reviewer 必须引用源码/机械检查证据；不同 lens 使用不同 rubric | 无证据 defect 比例；人工抽检 precision/recall |
| Rubric drift | Evaluator 奖励流畅度而不是正确性 [PDF p.2 §II.A] | 冻结 task/rubric 版本；先跑 hard gates | rubric version；硬失败却被判 clean 的次数 |
| Non-monotonic repair | 修复一个问题引入另一个 [PDF p.2 §II.A] | 每轮全量回归，不只复查目标页面 | 新增 defect 数；每轮 hard-gate delta |
| Tool misuse | 选错工具、参数错误、盲信结果、过度调用 [PDF p.3 §II.B] | typed inputs、路径 containment、明确截断/失败、只读 repo | invalid calls、empty/truncated results、重复调用率 |
| Plan-execution gap | 计划包含无法执行步骤或坏依赖；失败级联 [PDF p.3 §II.C] | 计划 schema 与 dependency preflight；失败分 retry/replan/stop | invalid plan 率；blocked dependency；保留成功工件比例 |
| Unbounded replanning/repair | 无法收敛并持续消耗 token [PDF pp.2-3 §II.A/C] | 全局 step/round/token/time budget；每轮必须有 defect delta | stop reason；round count；无改善轮次 |
| Redundant agents / groupthink | 相同 evidence/rubric 重复同一错误 [PDF p.3 §II.D；p.6 §VIII] | 按独特 scope/lens 分工；做 agent ablation | 去掉角色后的质量、成本、延迟变化 |
| Orchestrator context bottleneck | Root 接收所有 worker 全文导致上下文昂贵且嘈杂 [PDF p.4 §III.D/§IV.A-C] | receipt 引用 + 有界摘要；详情按需加载 | Root input tokens；receipt 命中率；截断率 |
| Graph preserves bad facts | graph 会高效保存错误 [PDF p.5 §IV.F] | provenance、冲突而非覆盖、版本化、定期复核 | 无来源 claim、冲突未呈现、错误 supersession |
| Cost/latency without lift | 更多循环和 agent 增加 token、延迟和复合错误 [PDF p.6 §VIII] | 任何新模式都与同任务 baseline 做 ablation | quality/cost、quality/latency、publishable-run rate |

---

## 4. 面向 Wiki 的评估方法

PDF 最可靠的评估建议是：每个阶段有 baseline、task-level metric、cost budget 和 rollback；在同一任务集上比较有无 Reflection；同时跟踪 component、workflow、operational metrics；优先 deterministic checks，模型 evaluator 使用显式 rubric，高风险或模糊结果保留人工 review，模型或 prompt 变更前跑 regression。[PDF p.5 §V；p.7-8 Appendix A-E]

Anthropic 的一手表述与此一致：先用 comprehensive evaluation 优化简单方案，只有在结果可测提升时才增加 multi-step agentic system。[Anthropic, Summary](https://www.anthropic.com/engineering/building-effective-agents#summary)

### 4.1 最小实验设计（推论）

固定一组 repository snapshot 和同一 wiki task/rubric，逐层做 ablation：

| Variant | 唯一新增机制 | 回答的问题 |
|---|---|---|
| A | 单次固定链生成 | baseline 在哪里失败？ |
| B | A + deterministic gates | 多少错误无需 LLM reviewer 即可捕获？ |
| C | B + 1 个 bounded evaluator/repair loop | Reflection 是否提高 publishable rate，成本多少？ |
| D | C + 按 repo domain 并行 evidence workers | 大 repo 的 coverage/latency 是否改善？ |
| E | D + 分 lens reviewers | 各 reviewer 是否捕获独特 blocking defect？ |
| F | E + durable graph | 只有出现 graph trigger 后评估；是否优于简单 artifact store？ |

每次只加一个机制，保留相同模型、snapshot、任务和预算；否则无法判断提升来自 workflow、模型还是额外 token。

### 4.2 指标（推论）

| 层 | 指标 |
|---|---|
| Hard correctness | 必需页覆盖率；frontmatter/schema 通过率；内部链接有效率；引用路径/行号可解析率；发布门通过率 |
| Grounding | 抽样 claim 被引用源码蕴含的比例；无来源或错误来源 claim 数；冲突证据呈现率 |
| Coverage | 计划问题回答率；关键模块/入口/配置/失败路径覆盖；人工 gold questions recall |
| Coherence | 页面间术语、导航、重复与矛盾 defect；单 writer 与多 writer 的差值 |
| Repair | blocking defect 收敛率；每轮新增回归数；达到上限仍未解决率；stop reason 分布 |
| Operations | 完成/失败/取消率；wall time；token 与费用；tool error；峰值 root context；每个 publishable wiki 的成本 |
| Change safety | 同 snapshot 重跑方差；模型/prompt/skill 变更前后的 regression；rollback 成功率 |

LLM-as-judge 只能作为一项信号。Grounding 需结合确定性引用检查和人工抽样；否则会重现 PDF 所说的 self-confirmation 与 rubric drift。[PDF p.2 §II.A；p.8 Appendix Evaluation]

### 4.3 晋级规则（推论）

一个新模式只有同时满足下列条件才进入默认路径：

1. 在固定 benchmark 上改善预先声明的错误类；
2. 增益在重复运行中稳定，不只是一次样例；
3. 成本、延迟和失败率仍在预算内；
4. 新机制的 stop/failure 状态可观测；
5. 可以关闭并回退到前一 variant。

这比采用 PDF 的 `Day 1 / Week 1 / Month 1` 时间线更可执行；后者没有数据支撑。[PDF pp.5-6 §V/Table III]

---

## 5. 优化优先级

| 优先级 | 建议 | 证据性质 |
|---|---|---|
| P0 | 固定可观测链路；明确 task/rubric；机械 validate；结构化 defects；bounded repair；停止原因 | Andrew/Anthropic 一手材料与 PDF 都支持 |
| P0 | Repo read-only、staging write-only；typed tool schema；参数/结果/路径校验 | Andrew/Anthropic 一手材料与 PDF 都支持 |
| P1 | 动态 planning 只负责 repo 特有分解；structured plan、dependency/budget preflight、保留成功工件 | Planning 一手材料支持方向；具体 schema 是本文推论 |
| P1 | 仅对独立 evidence scope 和独立 review lens 做并行；用有界 artifact handoff | Parallelization/Multi-Agent 一手材料支持方向；wiki 写入策略是本文推论 |
| P2 | 用 benchmark 做 reviewer/worker ablation、quality/cost 与 regression gate | Anthropic 的“measurable outcomes”及 PDF evaluation 建议支持 |
| Deferred | Knowledge graph、开放式多 agent 对话、多个 writer、无限 replan | 来源未证明必要；应等明确 trigger 和对照实验 |

### 不应从该 PDF 推出的结论

- Andrew Ng 是该 PDF 作者；
- HumanEval 95.1% 证明 repo-to-wiki 也会提升；
- 四种 Ng pattern 和五种 Anthropic workflow 应全部叠加；
- Multi-agent 数量本身带来独立性或质量；
- Graph 是成熟度终点或首版必要组件；
- `10-30%`、1 天、1 周、1 月可直接用于本项目承诺。

---

## Source Map

| 主题 | 原始来源 |
|---|---|
| 本次 Drive 材料 | [Andrew Ng — My 4 Steps - From Loop Engineering to Graph Engineering](https://drive.google.com/file/d/1G33UqJQpul8r28Xjo_9TgVV0RPyEbGxM/view), pp.1-8，未署名独立汇编，July 2026 |
| Sequoia 演讲 | [What's next for AI agentic workflows ft. Andrew Ng of AI Fund](https://www.youtube.com/watch?v=sal78ACtGTc), Sequoia Capital, 2024-03-26 |
| 四种 agentic pattern 与 HumanEval 报告值 | [Agentic Design Patterns Part 1](https://www.deeplearning.ai/the-batch/how-agents-can-improve-llm-performance/), Andrew Ng / DeepLearning.AI, 2024-03-20 |
| Reflection | [Agentic Design Patterns Part 2, Reflection](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-2-reflection/), 2024-03-27 |
| Tool Use | [Agentic Design Patterns Part 3, Tool Use](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-3-tool-use/), 2024-04-03 |
| Planning | [Agentic Design Patterns Part 4, Planning](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-4-planning/), 2024-04-10 |
| Multi-Agent Collaboration | [Agentic Design Patterns Part 5, Multi-Agent Collaboration](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-5-multi-agent-collaboration/), 2024-04-17 |
| Workflow/agent 区分、五种 workflow、复杂度与评估原则 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), Erik Schluntz and Barry Zhang / Anthropic, 2024-12-19 |
