# Anthropic 多代理模式对 multi-source domain 与 research batch 的启示

日期：2026-08-17

## 范围与证据边界

用户给出的当前 URL 是 Anthropic Frontier Red Team 在 2026-08-13 发布的 [Patterns and problems in emerging multiagent systems](https://www.anthropic.com/research/multiagent-systems)，不是 2025 年介绍 Research 产品架构的文章。两篇一手资料回答不同问题：

- **2026 研究文**比较独立并行与协调 swarm，并研究共享资源、同质化、信息聚合和目标冲突的系统性风险；它不规定 Lead/subagent 的 batch 或写作流程。
- **2025 工程文** [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) 描述 orchestrator-worker、Lead synthesis、并行 subagent、迭代补充、token 成本和 artifact handoff；本文只用它回答用户关于 research batch 与 write 职责的问题。

没有把非 Anthropic 文章当作事实来源。

仓库现状来自当前 `wiki-workflows` 代码和生产 skill。下文把三类内容分开：

- **Anthropic 事实**：原文明确描述的架构、数据或经验。
- **仓库事实**：当前实现、提示和约束。
- **设计推论**：把两者映射后得到的建议，不把 Anthropic 的内部评测直接外推成本项目结论。

## 结论

1. **`source` 应是隔离与 provenance 根，不应同时充当最终语义 domain。** 当前 Lead 指令要求先识别 domain，却又把研究单元写成 `Source×Domain`；如果首轮只按 source 分派，模型很容易把 source 名直接提升为 domain 名。更合适的模型是 `Source root -> semantic Domain -> Concept`：不同 source 保持命名空间和证据隔离，每个 source 内继续按职责、业务能力或运行边界拆 domain；全局 overview/architecture 再表达跨 source 关系。
2. **当前任务更适合“独立、边界清楚的并行切片”，不适合让 researcher 组成自由协作 swarm。** 2026 研究文指出，agent 把其他 agent 当作有明确输入/输出/artifact 的 tool invocation 时能有效协作；没有清楚层级的长期 peer coordination 仍然困难。共享代码实验还出现冲突 PR、低合并率和通过文件 silo 规避冲突。[Measuring coordination](https://www.anthropic.com/research/multiagent-systems) 本仓库应由 Lead 预分配 source/domain coverage，由 artifact 汇合，researcher 不共享可写状态。
3. **不要把“尽量一次 batch”实现成“禁止补充 batch”。** 2025 Research 系统本身是首轮并行、Lead 综合、按缺口决定是否继续的迭代研究。合理目标是让第一次 research wave 尽可能覆盖完整，并让后续 research wave 只能由明确的 coverage gap、证据冲突或失败重试触发，而不是固定多轮。[Anthropic Research 架构与研究循环](https://www.anthropic.com/engineering/multi-agent-research-system)
4. **domain reconciliation 应发生在 `wiki_plan` 前的 Lead synthesis，而不是首次留到 writer。** 当前 writer 只能写 WikiSpec 已声明的精确 cluster，不能重构拓扑。writer 可以在簇内合并证据、解决措辞和局部冲突，也可以报告新 gap；但 source 内 domain 的拆分、跨 source 同名 domain 的对齐，以及最终 page path 都应由 Lead 在收集首轮研究 artifact 后统一决定。
5. **建议的主路径是“一次宽首批 + 一次集中综合 + 按 gap 补搜”。** 首批 researcher 的交付契约应包含 `source -> candidate domains -> concepts -> evidence -> conflicts -> gaps`，Lead 一次性做 taxonomy reconciliation 和 WikiSpec；writer 直接消费对应 artifact。只有明确缺口才补充 research，不因“准备写下一组页面”自然开启新 research batch。
6. **batch 数、task 数和真实并发需要分开看。** 当前单 batch 最多 4 个 research task，但默认总并发为 3 个 session，扣除 Lead 后通常只有 2 个 leaf 同时运行。把任务装进一个 batch 可以减少 Lead 往返和重复综合，但不会自动让 4 个任务同时跑；反过来，多开 batch 也可能只是在 admission gate 前排更多队。
7. **当前最具体的重复 batch 根因是 research coverage 没进入 durable control plane。** research task schema 只有 prose `instruction` 与 `sourceScopeIds`，没有 machine-readable domain/cluster；receipt 虽有 coverage/gaps，board 投影却只保留 status/error。Lead 在 compaction 后被要求依赖 board 恢复工作，但 board 无法回答“哪些 source×domain 已研究、还缺什么”，因此重复 dispatch 是可预期结果。应先补 `scopeKey/sourceId/domainId`（plan 后可关联 `clusterId`）及 board 的 coverage/gaps/remaining research coverage，再考虑放宽 fan-out。

## 1. 用户给出的 2026 研究文：并行与协作的边界

### 1.1 独立并行是当前更可靠的基本单元

Anthropic 认为，当前 agent 在把同伴当作具有清楚 prompt、response 和 artifact 契约的工具调用时能够有效合作；面对没有明确 hierarchy、目标和行为各自持续变化的长期 peer 时，协调会明显变难。高度可并行、能拆成独立子问题的任务仍然适合简单 swarm，例如让不同 agent 分别检查不同 codebase、文件或 module。[Measuring coordination](https://www.anthropic.com/research/multiagent-systems)

这直接支持本仓库的 `Source root -> Domain` 切片：source 是读取权限和 provenance 边界，source 内再把彼此独立的 domain/module 分给不同 researcher。研究者之间通过 host 持久化的 immutable artifact 交接，不需要开放式互聊或共同编辑一个 taxonomy 文件。

### 1.2 协调 swarm 扩大探索面，但成本与归因需要拆开看

在漏洞实验中，Mythos Preview 的独立并行方法以 650 万 token 找到 21 个漏洞，协调 swarm 以 2700 万 token 找到 266 个；但 swarm 约一半发现来自独立方法没有被允许搜索的 core 目录之外。限制到相同 core scope 后，两种方法的 token/发现效率看起来相近，而且两者只有 12 个漏洞重合。Anthropic 的判断是两种方法具有互补性：预分配独立 agent 能系统覆盖指定位置，swarm 能动态选择更有产出的方向并形成专门化。[漏洞协调实验](https://www.anthropic.com/research/multiagent-systems)

对本项目的推论是：

- 若目标是完整 Wiki coverage，首批应优先采用预分配 source/domain slice，避免 swarm 全体追逐“最容易写”的区域；
- Lead 可以保留少量 gap-triggered 自适应任务，补足首批没有预见的跨 source 关系；
- 评价时必须固定 coverage scope，不能把“更多发现”直接归因于 agent 协调，而忽略它搜索了更大范围和花了更多 token。

### 1.3 共享写入、模糊 ownership 和更多 agent 会放大协调风险

Anthropic 的共享代码实验让多个 agent 在同一 repository 工作。较早模型经常改相同文件却无法合并冲突 PR；较新模型一度主要靠高文件 ownership、很少共享代码来维持吞吐。实验中的 prescriptive roles 和 CEO hierarchy prompt 没有显著改变最终效果；这只是该实验结果，不代表 hierarchy 普遍无效。[共享代码协调实验](https://www.anthropic.com/research/multiagent-systems)

本仓库因此应保留这些 deterministic guardrail：researcher 对 source 只读、每个 artifact 独立落盘、writer 对 exact cluster/path 单写者 ownership、review 与 write 分离。可以由 Lead 做中心化 synthesis，但不应让多个 researcher 或 writer 共同修改一个 page/taxonomy 再依赖它们自行解决冲突。

### 1.4 同质化会制造重复研究和盲点

2026 研究文把相同模型、context、scaffolding 下的 agent 描述为低方差：多个 agent 容易采取相同行动，甚至产生相同 branch 名或项目选择。agent 数量增加并不自动带来探索多样性，坏决策反而可能成为系统性行为。[Failures from conformity](https://www.anthropic.com/research/multiagent-systems)

这解释了为什么“一个 source 一个同样 prompt 的 researcher”仍可能产生重复、浅层 domain：所有任务看到相似指令时，可能都按 repository 名或相同目录启发式分类。首批任务需要不同且互斥的 objective、source/domain boundary、输出 schema 和停止条件；必要时还应区分 breadth inventory、runtime flow、public contract 等视角，而不是复制同一泛化 survey prompt。

### 1.5 synthesis 必须保留 source-local 异议和 provenance

Anthropic 发现两类相反的 epistemic failure：agent 可能轻信不可靠来源，也可能在 hidden-profile 任务中过早收敛到共同信息，忽视某个 agent 独有但关键的事实。单纯提高全局“信任”或“怀疑”都不能同时修复两者。[Epistemic failures](https://www.anthropic.com/research/multiagent-systems)

对 multi-source synthesis 的含义是：Lead 不应先抹平 source 边界再总结。artifact 应保留每条 domain 判断的 source/evidence、冲突和置信缺口；Lead 对齐同名 domain 时必须能看见少数 source 的独有事实，writer/reviewer也应能回到原始证据。`source` 作为 namespace/provenance root 因而不仅是导航需求，也是防止错误共识的信息结构。

## 2. 2025 Research 工程文：Lead、batch 与 synthesis

### 2.1 Lead、subagent 与 synthesis

Anthropic 使用 orchestrator-worker：Lead 分析问题、制定策略并创建并行 subagent；subagent 各自在独立 context 中迭代搜索并压缩发现，Lead 汇总结果并判断是否需要更多研究。研究充分后，系统再把 findings 交给 CitationAgent 做 claim-to-source 定位。[架构概览](https://www.anthropic.com/engineering/multi-agent-research-system)

这一区分很重要：

- subagent 的职责是**独立探索和高信号压缩**；
- Lead 的职责是**分解、覆盖判断、跨结果综合和下一步决策**；
- 后处理 agent 的职责是**对已有报告做引用定位**，不是重新决定研究 taxonomy。

Anthropic 还强调 delegation instruction 必须包含目标、输出格式、工具/来源指导和清楚边界；短而含糊的指令会造成重复搜索、遗漏和对子任务的不同理解。[Teach the orchestrator how to delegate](https://www.anthropic.com/engineering/multi-agent-research-system)

因此，对本仓库的合理推论不是“一个 source 对应一个 researcher/domain”，而是：先以 source 限定权限和 provenance，再以相互独立的语义方面划分研究责任；每份 handoff 都显式返回 source 内部的 domain 候选及证据。

### 2.2 并行首批与迭代补充并不冲突

Anthropic 明确表示 research 是动态、路径依赖的，线性 one-shot pipeline 无法覆盖开放式研究；Lead 在收到第一轮结果后会决定是否继续创建 subagent 或调整策略。[Benefits 与完整流程](https://www.anthropic.com/engineering/multi-agent-research-system)

同时，Anthropic 把并行作为主要提速手段：复杂任务中 Lead 一次启动 3-5 个 subagent，每个 subagent 又并行调用 3 个以上工具；相对早期串行搜索，其复杂研究时间最多下降 90%。这不是要求固定使用 3-5 个 agent；同一篇文章也给出 effort scaling：简单事实约 1 个 agent，直接比较约 2-4 个，复杂研究才可能超过 10 个。[Scale effort 与 parallel tool calling](https://www.anthropic.com/engineering/multi-agent-research-system)

所以应优化的是 **first-wave completeness**，而不是 `batch_count == 1`：

- 首批尽可能覆盖可预见、彼此独立的方面；
- Lead 只在首批之后做一次集中 coverage/conflict 检查；
- 第二批必须引用具体 gap，不接受泛化的“继续研究”；
- 补搜范围应比首批窄，且直接服务某个待写 cluster 或冲突。

### 2.3 同步 batch 的代价

Anthropic 当前实现会同步等待一组 subagent 全部完成。优点是协调简单，代价是 Lead 无法中途 steering、subagent 不能互相协调，而且最慢任务会阻塞整组。其文章认为异步执行能增加并行度，但同时引入结果协调、状态一致性和错误传播问题。[Synchronous execution creates bottlenecks](https://www.anthropic.com/engineering/multi-agent-research-system)

本仓库已经采用异步 start/collect，因此不需要为了“像 Anthropic”退回同步执行。更值得借鉴的是**逻辑 wave**：同一轮问题尽量一次派发，收集后统一综合。runtime batch 只是持久化和调度单位，不应自然等同于一次新的研究推理阶段。

### 2.4 token、成本与质量

Anthropic 报告：在其 BrowseComp 分析中，token 使用量单独解释了 80% 的性能方差；其内部研究评测中，Opus 4 Lead + Sonnet 4 subagent 相比单 Opus 4 高 90.2%。同时，其 agent 约使用普通 chat 的 4 倍 token，多代理系统约使用 15 倍 token。因此多代理适合高价值、可强并行、信息量超出单 context 的任务，不适合依赖密集共享 context 的任务。[性能与成本数据](https://www.anthropic.com/engineering/multi-agent-research-system)

这些数值只能说明 Anthropic 系统中的方向性权衡，不能当成本仓库的预期收益。对本项目更直接的成本控制是：避免多个 batch 重复勘察同一 source、避免把完整 artifact 在 Lead 与 writer 对话中重复复制，并按语义 gap 而非固定流程追加任务。

### 2.5 artifact 与“传话损失”

Anthropic 建议某些 subagent 结果直接写入文件系统或外部 artifact，向 coordinator 只返回轻量引用。这样能减少大型结果多次穿过 Lead 的 token 开销，并避免多级摘要造成信息损失，尤其适合代码、报告和结构化输出。[Subagent output to a filesystem](https://www.anthropic.com/engineering/multi-agent-research-system)

本仓库已经采用 content-addressed Markdown artifact 和 compact receipt，这一基础与 Anthropic 建议一致。优化重点应从“是否需要 artifact”转向“artifact 是否包含 writer 可直接消费的 domain/evidence 索引，以及 Lead 是否只按需读取”。

## 3. 当前仓库的关键约束

### 3.1 source 是权限 scope，不是语义 domain

生产计划只把 source 的 `scopeId` 列给 Lead；leaf 通过 `sourceScopeIds` 获得对应 source root 的读取权限。当前数据模型没有声明 `source -> domain` 的结构化字段。[Lead prompt](../../packages/wiki-workflows/src/production-run.ts#L671) [leaf source scope](../../packages/wiki-workflows/src/lead-runtime.ts#L402)

生产 skill 要求 Lead 完成初步 inspection 后提交完整 WikiSpec，并把 research dispatch 单元描述为 “One Source×Domain”。这是正确方向，但没有进一步规定“一个 source 至少先产出内部 domain inventory”或“不得直接以 source 名当 domain”，因此模型可能在浅层 inspection 后把物理 source 名沿用为语义 domain。[Lead production brief](../../packages/wiki-workflows/skills/wiki-production/SKILL.md#L12)

### 3.2 当前 topology 只有 Domain -> Concept

当前合法路径是 `<domain>/domain.md` 和 `<domain>/<concept>/{concept,models,flows,...}.md`，parser 用第一个 path segment 识别 domain、前两个 segment 识别 concept cluster。[topology reference](../../packages/wiki-workflows/skills/wiki-production/references/topology.md#L8) [WikiSpec parser](../../packages/wiki-workflows/src/lead/spec.ts#L29)

因此，若真正采用 `Source root -> Domain -> Concept`，不能只改一句 prompt。需要先决定 source root 是：

1. **显式 namespace 层**：`<source>/<domain>/domain.md`，再向下放 concept；语义最清楚，但需要扩展 WikiSpec、cluster/index、验证、链接和模板约束。
2. **复用现有 domain 层**：source 作为 `<domain>`，内部语义 domain 降级成 `<concept>`；改动小，但会混淆 domain/concept 语义，且内部 domain 无法自然拥有自己的 concept 层。
3. **扁平前缀**：`<source>-<domain>/domain.md`；兼容当前 parser，却失去真正的 source 根和自然导航。

从用户要求的“不同 source 隔离，source 内部继续拆分”看，方案 1 的语义最稳定；方案 2 只适合短期兼容，不宜固化为领域模型。

### 3.3 research batch 目前受两个不同上限约束

dispatch 层把单 batch 的 research task 数固定为最多 4；write/review 分别为 2。[dispatch fan-out](../../packages/wiki-workflows/src/lead/dispatch.ts#L11)

执行层另有全局 session admission：默认 `maxConcurrentAgents = 3`，其中包含 Lead，因此生产创建 task runtime 时通常给 delegated agents 留 2 个并发位。配置还允许全 Run 最多 24 个 delegated task、8 个 batch；这些是预算上限，不是建议每次都用满。[runtime settings](../../packages/wiki-workflows/README.md#L73) [Lead loop](../../packages/wiki-workflows/README.md#L173)

这意味着：

- 一个 4-task research batch 在默认配置下通常分两波实际执行；
- 超过 4 个 `Source×Domain` 单元时，Lead 被迫创建多个 runtime batch；
- 只把多个 runtime batch 合并成一个更大的 task 列表，不会提升默认真实并发，但会减少 Lead 的 dispatch/collect/再规划往返；
- 若任务数远超实际并发，过宽首批还可能让较晚任务基于过时 taxonomy 排队。

### 3.4 durable board 不知道 research 覆盖了哪个 domain

Lead-facing research task schema 只有 `id`、`instruction`、`sourceScopeIds`、`contextRefs`；`cluster` 只存在于 write/review task。内部 `expandDispatchTask` 也只为 write/review 把 cluster 展开为 path，research 仍是 pathless prose contract。[research task schema](../../packages/wiki-workflows/src/lead/host-tools.ts#L10) [dispatch expansion](../../packages/wiki-workflows/src/lead/run.ts#L849)

这会造成 control-plane 缺口：

- research receipt 原始模型有 `coverage` 和 `gaps`，但 `boardInput` 只投影 receipt 的 `status/error`；
- board 明确把 research task 当作无 path task，不让它影响任何 cluster status；
- board task 行也只显示空 paths、phase 和 receipt status，不显示 source/domain coverage 或 gap；
- production skill 又要求 Lead 在 compaction 后和每次 dispatch 前读取 board。

相关实现见 [board receipt projection](../../packages/wiki-workflows/src/lead/run.ts#L812)、[research pathless 语义](../../packages/wiki-workflows/src/lead/board.ts#L77)、[cluster 忽略 research](../../packages/wiki-workflows/src/lead/board.ts#L100) 和 [board task projection](../../packages/wiki-workflows/src/lead/board.ts#L159)。

因此，即使 artifact 中已有完整发现，durable board 也无法证明某个 `source×domain` 已覆盖；Lead context 一旦压缩，就只能靠 task id、prose summary 或重新读取多个 artifact 猜测剩余 research。多开 batch 不一定是模型单纯“不会停止”，也可能是持久状态没有表达停止条件。

建议把 research coverage 变成显式 control data：

- task contract 增加稳定 `scopeKey`，并结构化记录 `sourceId` 与 candidate `domainId`；
- research 发生在 `wiki_plan` 后时可再绑定 `clusterId`，plan 前不要强迫虚构最终 cluster；
- receipt/board 持久展示 coverage、gaps、artifact ref 和 completion；
- board 增加 `remainingResearchCoverage`，由 host 对 scope key 做去重和 gap closure；
- Lead 的第二批 task 必须引用未完成 scope 或 gap id，host 可拒绝无依据的重复 coverage。

这比仅在 prompt 中写“尽量一次 batch”更可靠，也符合 2026 研究文强调的 well-defined input/output/artifact contract。

### 3.5 writer 不能承担首次 topology 决策

`wiki_plan` 在任何写作或 review 前固定合法页面集合；writer 只获得精确 `writePaths`，host 会拒绝未声明或跨 cluster 的写入。[production brief](../../packages/wiki-workflows/skills/wiki-production/SKILL.md#L14) [write reference](../../packages/wiki-workflows/skills/wiki-production/references/write.md) [dispatch validation](../../packages/wiki-workflows/src/lead/dispatch.ts#L66)

因此“write 的时候再分析”应被拆成两件事：

- **可以推迟到 writer**：簇内证据复核、跨 source 事实合并、冲突表述、页面结构和引用落点；
- **不能首次推迟到 writer**：source 内 domain 划分、domain/cluster 命名、page path 集合和跨 cluster 归属。

后者必须在 research artifact 收集后、`wiki_plan` 提交前由 Lead 完成。若 writer 发现 taxonomy 错误，只能返回 gap，由 Lead 修订 WikiSpec；这会使已写内容和 review 失效，成本高于前置 reconciliation。

## 4. 推荐的目标流程

```text
Lead cheap reconnaissance
  -> 按 source 建 domain inventory，不直接采用 source 名作为 domain
  -> 一次 dispatch 首批独立 coverage slices
  -> researchers 产出结构化 domain/evidence artifacts
  -> Lead 单次 synthesis + taxonomy reconciliation
  -> wiki_plan
  -> writers 按 cluster 复核并综合证据
  -> 仅显式 gap/conflict 触发窄补搜
  -> independent review
```

### 4.1 首批 task 的建议边界

把目前的 “One Source×Domain” 改得更可执行：

> One independent coverage slice. Preserve source isolation, but identify and report semantic domains inside each assigned source. Never use the source name as a domain unless evidence shows it is also the system's domain term.

每份首批 handoff 至少返回：

```yaml
source: source-a
candidateDomains:
  - id: runtime
    responsibility: execution and lifecycle
    evidence: [source-a/src/runtime.ts#L10-L80]
    concepts: [sessions, retries]
crossSourceLinks:
  - targetSource: source-b
    relation: calls its adapter boundary
conflicts: []
gaps: []
```

这只是研究交付 schema 的示意，不意味着要把 YAML 直接加入产品 API。关键是让 coverage 和 gap 以 domain 为单位可比较，使 Lead 能一次完成 dedupe、rename、merge/split 和 page planning。

### 4.2 何时允许第二个 research wave

建议只允许以下 trigger：

- 某个计划 domain 没有达到最低证据覆盖；
- 两个 artifact 对 domain 边界或关键事实冲突；
- 首批明确返回 `incomplete` 或结构化 gap；
- writer 在重开 load-bearing source 后发现无法支撑已计划页面；
- 某个 source×domain task 失败或超时，需要定向替代，而不是整批重跑。

不应把以下理由当作 trigger：

- 开始写下一组页面；
- Lead 尚未读取已有 artifact；
- 用更泛的指令重复 survey 同一 source；
- 为了“更全面”而没有列出具体未覆盖问题。

### 4.3 一批还是多批的判断表

| 情况 | 建议 |
| --- | --- |
| source 少、内部 domain 可在 cheap reconnaissance 中识别、首批 task 不超过 fan-out | 一个 research batch |
| source×domain 多于 4，但实际并发仍为 2 | 优先按相关 domain 打包成最多 4 个清晰 coverage slice；不要仅为凑单批制造超大含糊任务 |
| taxonomy 高度不确定，后一任务必须依赖前一发现 | 两轮：宽 inventory 后窄深化；这是必要依赖，不强求单批 |
| 多 source 之间几乎独立 | 同一逻辑首批并行，artifact 按 source 隔离，Lead 后统一综合 |
| 共享 context/跨 source 依赖密集 | 减少 subagent 数，由 Lead 或单个跨 source task 保留共同 context |
| 首批已有完整覆盖，只是 writer 尚未开始 | 不再开 research batch，直接把 artifact ref 交给 writer |

## 5. 建议的渐进改进顺序

本轮不改代码。后续若实施，建议按以下顺序验证：

1. **先加观测而非先改预算**：为每个 research batch 记录 `trigger`、source/domain coverage、与既有 artifact 的重复率、最终被哪些 writer 读取，以及 Lead 在 collect 后是否真的更新 WikiSpec。
2. **收紧 Lead/researcher prompt**：明确 source 是 isolation/provenance root；要求 source 内 domain inventory；规定第二轮的 gap gate 和停止条件。
3. **在 `wiki_plan` 前增加一次显式 synthesis checkpoint**：Lead 必须说明 domain 的 merge/split/rename 决策及其 artifact 依据，再提交路径。
4. **再评估固定 fan-out 4**：如果 traces 显示大多数额外 batch 只是第 5-6 个独立任务，可让单 batch task 上限与 `maxConcurrentAgents`/排队预算相关；如果额外 batch 来自 taxonomy 不确定，提高 fan-out 只会扩大重复研究。
5. **最后设计 source namespace topology**：若确认 source 根是稳定产品语义，再扩展 WikiSpec 和路径层级；避免先用“source 作为 domain、内部 domain 作为 concept”的兼容映射污染长期模型。

## 6. 验证指标

优化不能只看 batch 数下降。至少比较：

- 每 Run 的 research batch 数、task 数、真实同时运行 task 峰值；
- 首批 artifact 对最终 WikiSpec domain 的覆盖率；
- 后续 batch 中与已有证据/路径重复的比例；
- `incomplete`/gap/conflict 的触发和关闭率；
- research token、Lead synthesis token、writer 重读 token，以及总 wall time；
- writer 因 taxonomy 或证据不足请求返工的比例；
- 最终 review 的 completeness、source quality、citation accuracy 和 cross-domain coverage。

Anthropic 对 agent evaluation 的建议也是按结果质量、引用准确、完整性、来源质量和工具效率评估，而不是要求执行路径完全一致；本项目同样不应把“恰好一个 batch”本身设为成功指标。[Effective evaluation of agents](https://www.anthropic.com/engineering/multi-agent-research-system)

## 最终判断

用户观察是成立的：在 multi-source Wiki 中，source 名最多应成为 namespace/provenance 隔离根，不能替代 source 内部 domain 识别。当前 topology 又不足以原生表示 `Source -> Domain -> Concept`，所以这不只是 prompt wording 问题，最终需要领域模型和路径规范决策。

2026 研究文支持优先采用**边界清楚、ownership 明确、artifact 汇合的独立并行**，避免让同质 agent 在共享写入面上自由协调；2025 工程文则支持 batch 目标不是“强制一批”，而是：**一次尽可能宽且边界清楚的首批、Lead 在 write 前集中综合、writer 做簇内证据分析、后续仅由结构化 gap 触发窄补搜**。这能同时减少无意义多轮，又保留开放式研究必须具备的适应性。
