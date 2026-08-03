# Multi-source Plan 阶段偏差与单轮分析局限

> Research note only. Not an ADR.

**研究日期：** 2026-08-03  
**问题：** 当前 Plan 阶段在 **多 source（Repository Snapshot Set）** 场景下不够准确——容易偏重某些 source、结果单一、且有单轮采样带来的概率性漂移。  
**方法：** 对照本仓库 Plan 实现（skill、prompts、scouts、adaptive router）与外部一手/近一手文献（position bias、lost-in-the-middle、PlanRAG、MoA、self-consistency、per-source retrieval、MDS planning）。

---

## 结论（先读）

当前 Plan 管线对 **单仓** 已有合理骨架（可选 orthogonal scouts → 单一 synthesizer 提交 Spec），但对 **多 source** 仍是「按库存信号加 scout 数量」而不是「按 source 做覆盖与合成」。外部研究一致表明：

1. **单轮 / 单路径规划** 会把早期观察锚定成最终 Spec（primacy + plan-phase butterfly effect）。
2. **扁平拼接多源上下文** 会放大 position bias / lost-in-the-middle，使某一 source 主导页面树。
3. **有效缓解** 不是「再多读一点 README」，而是：**(a) per-source 强制覆盖、(b) 多样 proposer 再聚合、(c) 可校验的覆盖门、(d) 必要时 re-plan / multi-sample 一致性**。

对本产品的直接含义：**multi-source 应把 Plan 从「主题 scout（entry/layout/tests/risks）」扩展为「source-aware survey + coverage-gated synthesis」**，而不是只把 `planScoutCount` 从 0 提到 2。

---

## 1. 当前实现快照（本仓库）

### 1.1 Plan 语义合同

| 工件 | 路径 / 行为 |
|------|-------------|
| Skill 指令 | `packages/skill/references/plan.md`：从 `sources/` 入口探索 → 迭代读者问题 → `submit_wiki_run_spec` |
| 多仓挂载 | `sources/<id>/` 一 source 一挂载；引用需 `repo:<id>/path`（skill / citations） |
| Scouts | `plan-scouts.ts`：按 kind `entry \| layout \| tests \| risks` 并行，写 `analysis/plan-scouts/*.md` |
| Synthesizer | 单一 planner 读 scout receipts + 再扫 sources，提交一份 WikiRunSpec |
| Adaptive | `adaptive-router.ts`：`sourceCount >= 2` → large → 默认 2 scouts（仍是上述 kinds 前缀切片） |

### 1.2 与 multi-source 直接相关的缺口

| 缺口 | 证据 | 后果 |
|------|------|------|
| Scout **按主题轴** 切，不按 **source id** 切 | `PLAN_SCOUT_KINDS` + `selectScoutKinds(count)` 取前 N 个 kind | multi-source 时仍是 entry+layout；**没有「每个 source 至少一份 survey」** |
| Scout/Planner prompt **未要求 per-source 覆盖表** | `plan-scout.ts` / `plan.ts` 只说 inspect `sources/` entry points | 模型可在 token/注意力预算下只深挖 `sources/` 字典序第一个仓 |
| Adaptive 把 multi-source 折叠成 `large` | `multiSource \|\| fileCount` → 1–2 scouts | **覆盖语义被「规模」替代**；2 仓与 5 仓策略几乎相同 |
| 单 synthesizer、单次 Spec | `planWikiSpec` 一次 live 提交 | 无 multi-sample / self-consistency；同 seed/温度下 Spec 可漂移 |
| Scout 失败 soft | `runBestEffortChild` + 空 receipts 仍规划 | 某一 lens 静默丢失 → Spec 更窄、更偏存活 scout 所见 |
| Replan 不恢复 prior Spec | 既有研究 `current-wiki-workflow-optimization` P0-2 | operator「补另一 source」时仍可能从头锚定 |

Skill 文案写「Repeatedly choose unanswered reader question」，但 **Host 不强制多轮 re-inspect**；是否再扫完全取决于单次 agent 轨迹——这是概率性的，不是合同。

---

## 2. 外部材料：问题机制

### 2.1 Position bias / primacy（为何偏某些 source）

- LLM 在长上下文与多文档 QA 中对 **靠前** 材料权重更高；中间段落易丢（**lost in the middle**）。经典结果：Liu et al., *Lost in the Middle*（[Stanford PDF](https://cs.stanford.edu/~nfliu/papers/lost-in-the-middle.arxiv2023.pdf)）。
- LLM-as-judge / 选项排序存在 **first-position preference**（Zheng et al., MT-Bench 线；后续 position-bias 综述与 PINE 等 mitigation，如 [arXiv:2407.01100](https://arxiv.org/abs/2407.01100)）。
- **多 agent 协调** 中，coordinator 易偏向 **先返回的 sub-agent 提案**；debate 甚至会 **放大** 初始偏置（「Judging with Many Minds」类工作，[arXiv:2505.19477](https://arxiv.org/html/2505.19477v2)）。

**映射到本 Plan：**  
`ls sources/` 的枚举顺序、scout 文本拼接顺序（entry → layout → …）、planner 先读到的 README，都会变成 **隐式 prior**。多 source 时若无 per-source 强制槽位，**第一个挂载的仓几乎必然主导 overview / domains**。

### 2.2 单 pass RAG / 单轮 Plan 的局限

- 经典 retrieve-once-then-generate 对 **跨文档互补信息** 不足；即使 oracle retrieval，**合成本身仍难**（MSRS 等多源检索+合成基准讨论，见 [arXiv:2508.20867](https://arxiv.org/html/2508.20867v1) 一类工作）。
- **PlanRAG**（Lee et al., NAACL 2024，[arXiv:2406.12430](https://arxiv.org/html/2406.12430v1)）：显式 **plan → retrieve → re-plan**；去掉 re-plan 在 Locating 场景约掉 ~10.8pp。说明 **「只规划一次」会漏分析步骤**。
- **Plan\*RAG**（[arXiv:2410.20753](https://arxiv.org/abs/2410.20753)）：把多跳拆成 **DAG 子查询**，可并行、可依赖，避免把整条链塞进一次上下文。
- Agentic / multi-layer RAG 综述普遍指出：单 pass 无法恢复初始检索/规划错误；需要 sufficiency check 与回环。

**映射到本 Plan：**  
当前是 **（可选）并行 scout ×1 轮 → synthesizer ×1 轮**。没有：

- source 级 sufficiency（「每个 source 是否有 entry/layout 证据」）；
- Spec 级 re-plan（发现漏仓后改 domains/pages）；
- 对 openQuestions 的强制二次调查。

这与 PlanRAG 所批评的 **MIS（missed analysis）** 同类。

### 2.3 Plan-phase bias 与误差传播

- 规划/分解阶段的锚定、确认偏误、early-hop drift 会 **级联** 到检索与生成（planning-enhanced RAG 讨论，如 PAR/complexity-matched exemplars 相关工作，[arXiv:2504.16787](https://arxiv.org/html/2504.16787v2) 一类）。
- 坏 plan 的「蝴蝶效应」：页面树一旦在 Spec 定型，后续 Leaf/Domain/Writer 只在 Spec 预算内工作——**漏 source 在 Plan 之后几乎不可自愈**（除非 operator revise 或 replan 真正吃 feedback）。

**映射：** WikiRunSpec 是稀缺资源（仓库内既有 swarm 研究也强调 Spec 质量）。Multi-source 下 Spec 若只编码了 1/N 个仓的读者问题，整条 DAG 会系统性忽略其余仓。

### 2.4 多文档融合 / 覆盖，而非多数表决

- 经典 MDS：**content selection → document planning → realization**；融合要处理互补、冗余、矛盾（Barzilay et al. 主题交集；CST；图中心性等）。
- 现代做法偏好 **中间结构化 plan**（entity/event/QA blueprint），再生成，以提高可控与忠实度。
- **Per-source / equal-k 检索**：全局 top-k 易被「话多/相似度高」的单一 source 占满；按 source 定额再合并可提升覆盖（多文档 RAG 实践与 RA-RAG 等可靠性加权，[arXiv:2410.22954](https://arxiv.org/html/2410.22954v2)）。
- **Source balancing**（参数知识 vs user vs document，[arXiv:2604.22193](https://arxiv.org/html/2604.22193v1)）：多断言并存时模型交互 **次可加**；冲突会抑制某些源——不能假设「读到了就会用上」。

**映射：** Plan 需要的不是更长的单篇 survey，而是 **可检查的 source × 主题 覆盖矩阵**，以及 synthesizer 对 **冲突/缺口** 的显式 `openQuestions`（代码里已有 soft 文案，但无 schema 级强制）。

### 2.5 多样性与概率性：Self-consistency / MoA

- **Self-consistency**（Wang et al., ICLR 2023，[arXiv:2203.11171](https://arxiv.org/abs/2203.11171)）：多样推理路径 + 多数表决；温度 ~0.5–0.7 提供多样性；**单 greedy 路径方差大**。
- **Mixture-of-Agents**（Wang et al.，[arXiv:2406.04692](https://arxiv.org/html/2406.04692v1)）：异构 **proposers → aggregator**；异构 proposer 优于同模型多次采样；聚合是 **批判性合成** 而非选最好一条。

**映射：** 本仓库 scouts 已标注为 **MoA proposers**（`plan-scouts.ts` 注释），方向正确，但：

- proposer 轴是 **entry/layout/tests/risks**，不是 **sourceA/sourceB** 或 **source×lens**；
- 默认 multi-source 只开 2 个 proposer，且常是同模型；
- aggregator（planner）无强制「覆盖每个 source id」检查；
- 无第二轮 proposer 层（MoA 多层 refinement）。

因此仍呈现用户观察到的：**结果偏单一、跑次间漂移（概率性）**。

### 2.6 与本仓库既有研究的衔接

| 已有结论 | 来源 | 与 multi-source Plan 的关系 |
|----------|------|---------------------------|
| 并行适合独立证据，不适合多 writer 叙事 | `drive-wiki-workflow-source-analysis` | Plan scouts 应并行 **per-source 只读 survey**；Spec 仍单点合成 |
| Spec 是稀缺资源；树质量取决于 Spec | `wiki-generation-optimization` | 修 multi-source 应优先 Plan，而不是下游 Leaf 数量 |
| Operator focus / revise 语义丢失 | `current-wiki-workflow-optimization` P0-1/2 | 放大 multi-source：用户说「两仓对等」时 planner 可能仍看不见 |
| Adaptive light path 默认 0 scout | `adaptive-router` + Phase 7 | multi-source 虽会抬 scout，但 **抬的是 kind 数不是 source 槽** |

---

## 3. 失败模式目录（可测假设）

| ID | 现象 | 机制（文献 + 实现） | 建议观测 |
|----|------|---------------------|----------|
| MS-P1 | Spec domains/pages 几乎只来自一个 source | Primacy + 无 per-source 槽 | 统计 Spec 中 `repo:` / path 前缀的 source 分布熵 |
| MS-P2 | 小仓/文档少的仓被完全省略 | Global top 注意力 + README 长度偏置 | 对每个 freeze source 检查是否出现在 scout findings 或 Spec scope |
| MS-P3 | 跨仓边界（API 契约、共享协议）无 page | 单仓心智模型；MDS 融合缺失 | 人工集：已知跨仓接口是否有 critical page |
| MS-P4 | 同配置两次 Run Spec 差大 | 单样本规划方差（self-consistency 反面） | Spec page-set Jaccard 跨 seed |
| MS-P5 | Scout soft-fail 后 Spec 变窄 | Best-effort 静默降级 | scout ok 标志 vs Spec domain 数相关 |
| MS-P6 | multi-source 与单巨大 monorepo 策略相同 | Adaptive 把 multiSource 当 large | 对比 sourceCount=2/fileCount=100 vs sourceCount=1/fileCount=5000 的 scout kinds |

---

## 4. 改进方向（按 ROI，仍属研究建议）

### 4.1 Host 合同（优先，低模型依赖）

1. **Per-source coverage gate（Plan 完成条件）**  
   - Freeze 的每个 `sourceId` 必须在 scout receipts 或 Spec `domains[].scope` / 证据路径中出现至少一次。  
   - 未覆盖 → Plan Attempt fail 或强制补跑 `source-survey`，而不是 soft 前进。  
   - 对齐 skill 的 completion gate：「enough inspected evidence」→ 可机器检查的子集。

2. **Source-aware scout 拓扑**  
   - 当 `sourceCount >= 2`：  
     - 方案 A：`N = sourceCount` 个 **source-survey** scout（每个 cwd 视图或 prompt 限定 `sources/<id>/`）；  
     - 方案 B：`source × {entry,layout}` 有界笛卡尔积，cap 在 orchestration 预算内。  
   - 主题轴 scouts（tests/risks）可作为第二层，在 per-source 摘要之后。

3. **Synthesizer 输入结构**  
   - 不要只把 scout summary 按 kind 拼接；改为固定模板：  
     `## Source <id>\n- entry\n- layout\n- open`  
   - 并 **轮换 source 顺序**（或按 id 排序 + 显式「忽略顺序」指令），减轻 primacy。

4. **Spec schema 扩展（可选）**  
   - `pages[].sourceIds` 或 domain `sourceIds: string[]` 必填；validator 拒绝「有 source 从未被引用」。

### 4.2 语义 / 采样（中成本）

5. **轻量 self-consistency（仅 multi-source 或高 uncertainty）**  
   - 2–3 次 planner 采样（温度中等）→ 对 page path 集合做并集/多数 → 再一次 freeze 合成；或 page-set Jaccard 过低则标高 uncertainty 并加 scout。  
   - 对齐 Wang et al. self-consistency；成本可控在 plan 阶段。

6. **真 MoA 异构**  
   - scout 用 cheap 模型、planner 用 frontier（代码已有 `scoutModel` 钩子）；不同 kind/source 可轮换模型以增互补（MoA 实证：异构 > 同模多样本）。

7. **Sufficiency + re-plan 一步**  
   - PlanRAG 式：synthesizer 先输出 coverage checklist；若缺口 → 仅对缺口 source 再开一轮 scout，再 submit Spec。  
   - Host 限制 max replan rounds（已有 generation/retry 基建可挂）。

### 4.3 明确不要做的

| 反模式 | 原因 |
|--------|------|
| 仅把 `planScoutCount` 默认调到 4 | kinds 仍是 entry…risks，**不解决 source 偏置** |
| 多 planner 各交一份 Spec 再人工选 | 无 aggregator 合同 → 页面树冲突；违反「单点 Spec 权威」 |
| 用更长 monorepo 式 inventory 替代 per-source | inventory 是 accelerator 非 membership gate；且仍无跨仓融合 |
| 下游 Leaf 数量补救漏仓 | Leaf 只答 Spec 内 questions；漏仓应在 Plan 失败 |

### 4.4 与 ADR 的关系（非决策）

- ADR 0009（Snapshot Set）、0014（bounded recursive subagents）、0036（execution plan）已支持多仓与规划树；**缺口在 Plan 阶段的 source 覆盖合同与 scout 拓扑**，不必先开新 ADR 才能做实验，但若引入 `sourceIds` 进 Spec 或强制 coverage gate，应补 ADR/合同测试。

---

## 5. 建议的最小实验

1. **Fixture：** 2 个小 source（A 有 README+pkg，B 仅有 lib/ 无 README）。  
2. **基线：** 当前 adaptive multi-source（2 thematic scouts + planner）。  
3. **处理：** per-source survey scouts + coverage gate。  
4. **指标：**  
   - Spec 是否包含 B 的至少 1 个 domain/page；  
   - scout 路径前缀是否覆盖 A、B；  
   - 3 次独立 Run 的 page-set Jaccard（稳定性）。  
5. **成功线：** B 覆盖率从「偶然」→「硬门槛」；Jaccard 上升或方差下降。

---

## 6. 关键引用

### 本仓库

- `packages/skill/references/plan.md`
- `packages/agent/src/workflow/phases/plan-scouts.ts`, `plan-phase.ts`
- `packages/agent/src/prompts/plan-scout.ts`, `plan.ts`
- `packages/contract/src/adaptive-router.ts`
- `docs/research/current-wiki-workflow-optimization-2026-07-29.md`
- `docs/research/drive-wiki-workflow-source-analysis-2026-07-29.md`
- `docs/adr/0009-configure-a-repository-snapshot-set.md`
- `docs/adr/0014-use-planning-and-bounded-recursive-subagents.md`

### 外部（按主题）

| 主题 | 入口 |
|------|------|
| Lost in the middle | Liu et al. — [PDF](https://cs.stanford.edu/~nfliu/papers/lost-in-the-middle.arxiv2023.pdf) |
| Position bias / PINE | [arXiv:2407.01100](https://arxiv.org/abs/2407.01100) |
| Multi-agent judge bias | [arXiv:2505.19477](https://arxiv.org/html/2505.19477v2) |
| PlanRAG | [arXiv:2406.12430](https://arxiv.org/html/2406.12430v1) |
| Plan\*RAG | [arXiv:2410.20753](https://arxiv.org/abs/2410.20753) |
| Multi-source retrieval+synthesis | [arXiv:2508.20867](https://arxiv.org/html/2508.20867v1) |
| Plan-phase / complexity planning | [arXiv:2504.16787](https://arxiv.org/html/2504.16787v2) |
| Self-consistency | [arXiv:2203.11171](https://arxiv.org/abs/2203.11171) |
| Mixture-of-Agents | [arXiv:2406.04692](https://arxiv.org/html/2406.04692v1) |
| Source balancing (P/U/D) | [arXiv:2604.22193](https://arxiv.org/html/2604.22193v1) |
| Reliability-aware multi-source RAG | [arXiv:2410.22954](https://arxiv.org/html/2410.22954v2) |
| MDS / planning stage | EACL 2024 plan-based MDS 等；经典 Barzilay fusion (ACL 1999) |

---

## 7. 一句话

> **Multi-source Plan 的核心错误不是「scout 太少」，而是「把多仓当成大仓」：用主题透镜和单次合成代替 per-source 覆盖与可重规划。** 文献对 position bias、单 pass 规划与 MoA/self-consistency 的结论，与当前 `entry|layout` 切片 + soft scouts + 单 Spec 样本的实现一一对应；优先补 **source-aware survey + coverage gate**，再考虑多样本合成。
