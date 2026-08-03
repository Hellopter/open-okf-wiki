# 多仓库产品与信息聚合设计调研

> Research note only. Not an ADR.

**研究日期：** 2026-08-03  
**问题：** 同一业务/产品常跨多个 Git 仓库；业界有哪些类似产品，如何建模多仓，如何聚合信息？  
**对照：** open-okf-wiki 的 Repository Snapshot Set（`sources/<id>/` + 多源 citation）与 Plan/Research/Write 管线。

---

## 结论（先读）

业界对「多仓 → 一份可读知识」大致落在 **四条产品线**，聚合策略并不相同：

| 路线 | 代表 | 聚合单位 | 跨仓边从哪来 |
|------|------|----------|--------------|
| **A. 统一 Wiki / 叙事** | OpenWiki Personal、DeepWiki+Devin、Google Code Wiki、本产品 | 一篇/一树 Markdown 叙事 | LLM 综合 + 引用 |
| **B. 每仓档案 + 中心 Hub** | RepoSwarm（`.arch.md` → Architecture Hub） | 每仓一份结构化档案，再集中 | 并行分析后 commit 到 hub；跨仓靠 agent 读 hub |
| **C. 结构图 / 契约图** | RepoWise workspace、code-graph/SPG、LogicLens | Graph（服务/API/事件/表） | **确定性解析**（AST、路由、proto、co-change） |
| **D. 文档站点装配** | Antora、docs monorepo + CI | 组件版本站点 | 人工 AsciiDoc/MD 结构 + playbook 源列表 |

**没有「一种正确聚合」。** 高可信跨仓关系（谁调用谁、谁发什么事件）适合 **C**；给人读的架构故事适合 **A/B**；发布型产品文档适合 **D**。成熟做法是 **分层：先确定性边界，再 LLM 叙事**，而不是把所有仓的全文塞进一次 plan。

对本产品：已具备 **A 的骨架**（Snapshot Set + `repo:id/path` citation + 单 Root 叙事），但 **缺 B 的 per-repo 档案层** 与 **C 的跨仓边界抽取**；Plan 仍按主题 scout，未按 source 覆盖——与上一份 multi-source plan 研究一致。

---

## 1. 问题形态：同一项目，多个仓库

常见切分：

- 前后端分离、BFF、共享 lib、IaC、移动端各一仓  
- 微服务 polyrepo（每服务一仓）  
- 平台 + 插件 / SDK + 服务端  
- 「文档仓」与「代码仓」分离  

读者（与 agent）真正要的问题几乎都是 **跨仓的**：

- 端到端请求/事件怎么走？  
- 改这个 API 会炸谁？  
- 共享类型/协议的权威源在哪？  
- 上线顺序与所有权？  

单仓 wiki 再好，也答不全；**聚合设计 = 如何表示「仓内事实」+「跨仓边」+「统一叙事」**。

---

## 2. 类似产品地图

### 2.1 AI Wiki / 代码理解（偏路线 A）

| 产品 | 多仓怎么做 | 聚合方式 | 与本产品接近度 |
|------|------------|----------|----------------|
| **[OpenWiki](https://github.com/langchain-ai/openwiki)**（LangChain） | Code mode 单仓；**Personal mode** 多 git connector + Notion 等 | 连接器拉 manifest → agent 合成一份 personal wiki（OKF） | 高：OKF、Markdown wiki、agent 维护；多源在 personal 而非 code 默认路径 |
| **[DeepWiki](https://deepwiki.com/)**（Cognition/Devin） | **每仓一份 wiki**；Devin 索引全部 connected repos + 多仓 VM | 仓内 wiki + Ask 跨仓检索；非「一仓一树强制合成」 | 中：产品形态类似；跨仓靠平台索引而非单次 Snapshot Set |
| **Google [Code Wiki](https://developers.googleblog.com/introducing-code-wiki-accelerating-your-code-understanding/)** | 公开仓预览；私有走 Gemini 生态 | 自动结构化 wiki + chat | 中：单仓叙事为主 |
| **[CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)**（研究） | 大仓层次分解 + agent | 递归模块文档 + 图 | 中：单仓规模技巧可迁到「每仓再 reduce」 |
| **[DeepWiki-Open](https://github.com/AsyncFuncAI/deepwiki-open)** | 自托管 DeepWiki 类；多仓统一 wiki 有讨论 | 结构分析 + 生成 | 中 |

### 2.2 多仓档案 Hub（偏路线 B）

| 产品 | 设计要点 |
|------|----------|
| **[RepoSwarm](https://github.com/reposwarm)** | 并行调查多仓 → 每仓 **`.arch.md`**（overview、API、DB、events、deps…）→ commit 到 **Architecture Hub** 仓；Temporal 编排 + 按 commit/prompt 缓存；agent 挂载 hub 做跨仓上下文 |
| **Architecture Hub 变体**（社区） | 按 **facet** 目录（`api/`、`events/`、`dataflow/`…）每仓一文件，优化检索与增量，而不是单文件巨石 |

**聚合哲学：** 不先写「一个大故事」，先写 **可 diff、可检索的每仓标准档案**；跨仓故事由读 hub 的 agent/人二次合成。

### 2.3 结构智能 / 契约（偏路线 C）

| 产品 | 设计要点 |
|------|----------|
| **[RepoWise](https://github.com/repowise-dev/repowise) workspace** | 父目录多 git → 每仓独立 index + 工作区层：`contracts.json`、`cross_repo_edges.json`、`system_graph.json`；HTTP/gRPC/topic/DB **provider–consumer 匹配**；co-change；blast radius；MCP |
| **code-graph / SPG**（如 airCloset 46 仓实践） | Tree-sitter + 边界节点（API/DB/event）+ LLM 注解；MCP 给 agent **可验证事实** 而非原始全文 |
| **LogicLens** 等 | 多仓 AST → 语义图 + GraphRAG |
| **Sourcegraph** | 跨仓搜索/符号/SCIP；Cody 多仓上下文；**不做**完整 wiki 叙事，是智能底座 |

**聚合哲学：** 跨仓边优先 **确定性抽取**；LLM 做描述与查询，不负责发明「谁依赖谁」。

### 2.4 商业文档生成 / 企业知识

| 产品 | 多仓要点 |
|------|----------|
| **[DocuWriter](https://www.docuwriter.ai/)** | 多 Git 连接；AST + 检索；中心文档空间；Autopilot 跟 diff；宣称百仓级 |
| **Kodesage** 等 | 代码 + Jira + Confluence 多源巩固 |
| **Glean / Rovo / Notion AI** | 企业搜索；代码只是源之一 |

### 2.5 人工/半自动文档装配（偏路线 D）

| 产品 | 多仓要点 |
|------|----------|
| **[Antora](https://antora.org/)** | Playbook 列多 content source；**component name+version** 合并；distributed component 跨仓模块；`xref` 跨组件 |
| MkDocs multirepo、Docusaurus 多源 CI | 拉子仓 docs 进站点 |
| **repo-of-repos**（[模式](https://www.raffertyuy.com/raztype/repo-of-repos-pattern/)） | 外层 agent 工作区 `repos/*` 真 clone；读可跨仓、写单仓；`repos.yaml` manifest；`_plans/` 跨仓计划 |

**聚合哲学：** 结构由人（或模板）定义；工具只 **装配与发布**。

### 2.6 本产品当前位置

| 能力 | open-okf-wiki |
|------|----------------|
| 多仓输入 | **Repository Snapshot Set**（ADR 0009）：命名仓、钉 commit、ignore |
| 运行时布局 | `sources/<id>/` 只读挂载 |
| 引用 | 多源必须 `repo:<id>/path#L…`（机械校验） |
| 叙事 | 单次 Wiki Run → 一份 Staging/Published Wiki |
| 分解 | Plan Spec → Domain/Leaf 研究 → Root 写 |
| 未做（相对竞品） | 每仓标准档案层；跨仓契约图；per-source plan 覆盖门；增量 per-repo cache |

---

## 3. 业界怎么「设计」多仓

### 3.1 输入模型（Input）

| 模式 | 说明 | 例子 |
|------|------|------|
| **Workspace / Snapshot Set** | 显式 id 列表 + 修订钉死 | 本产品、RepoWise workspace、repo-of-repos `repos.yaml` |
| **Org 发现** | 扫 GitHub org，过滤活跃仓 | RepoSwarm |
| **Connector 清单** | 多源连接器（git、Notion…） | OpenWiki Personal |
| **Playbook sources** | 文档站点源 URL/branch/start_path | Antora |

**共同最佳实践：**  
- 每仓稳定 **id**（不是临时路径）  
- **钉 revision**（可复现）  
- 与密钥分离的配置（本产品 ADR 0009 已对齐）

### 3.2 处理拓扑（Process）

```text
                    ┌─ per-repo survey / .arch / index ─┐
 Snapshot Set  ──►  │  (parallel, cached by commit)     │  ──►  cross-repo join
                    └─ boundary extract (API/event/DB) ─┘         │
                                                                  ▼
                                                         system graph / contracts
                                                                  │
                                                                  ▼
                                              narrative wiki / hub / site / Q&A
```

| 阶段 | 单仓做什么 | 跨仓做什么 |
|------|------------|------------|
| Survey | 入口、布局、测试、风险 | **每个 source 一份**，防 primacy |
| Structure | 模块图、依赖 | 契约匹配、co-change、package dep |
| Narrative | 模块页 | overview 端到端、flows 跨仓、ownership |
| Serve | 仓内 wiki | hub / 统一 wiki / MCP / 站点 |

**关键分工（反复出现）：**

- **读可跨仓，写宜单权威**（repo-of-repos：explorer 跨仓只读，worker 单仓写）  
- **并行证据，集中叙事**（本产品既有 research 也强调；RepoSwarm 并行分析、hub 集中）  
- **确定性边 + LLM 文**（RepoWise / code-graph）

### 3.3 输出模型（Output）— 四种聚合形态

#### 形态 1：单一叙事 Wiki（本产品默认）

```text
wiki/
  overview.md          # 系统级
  architecture.md
  modules/frontend.md
  modules/backend.md
  flows/checkout.md    # 显式跨仓
```

- **优点：** 读者一条故事线；OKF 友好  
- **风险：** Plan 偏仓；跨仓边靠 LLM；难增量  
- **缓解：** per-source 页 + `sourceIds`；跨仓 flow 页；citation 强制 id

#### 形态 2：Hub of per-repo cards（RepoSwarm）

```text
architecture-hub/
  backend.arch.md
  frontend.arch.md
  shared.arch.md
  SYSTEM.md            # 可选二次综合
```

- **优点：** 并行、可缓存、可 diff、scale 到很多仓  
- **风险：** 跨仓故事弱，除非再有综合层  
- **缓解：** 标准章节模板 + hub 级 `system_graph` 或二次 agent

#### 形态 3：Graph-first（RepoWise / SPG）

```text
services --http--> services
       --event-->
       --db-->
```

- **优点：** blast radius、breaking change、agent 少幻觉  
- **风险：** 框架方言、动态调用难；不是散文文档  
- **缓解：** Graph + 按需 LLM 生成模块说明（RepoDoc 类）

#### 形态 4：Versioned docs site（Antora）

```text
component "product" @ 2.0  ← 多 content source 合并
```

- **优点：** 版本、导航、xref 成熟  
- **风险：** 依赖人写/维护 AsciiDoc 结构；非代码自动理解

### 3.4 跨仓边从哪里来（最难）

| 来源 | 可靠度 | 成本 | 典型用途 |
|------|--------|------|----------|
| OpenAPI / proto / AsyncAPI 共享仓 | 高 | 中 | 契约权威 |
| 静态路由/客户端调用解析 | 中高 | 高 | RepoWise 类 |
| 包依赖（package.json / go.mod） | 高 | 低 | 库边 |
| Git co-change | 中 | 中 | 隐式耦合 |
| LLM 读代码推断 | 低–中 | 中 | 叙事补充，需 citation |
| 人工 ADR / 架构图 | 高（若维护） | 人 | 意图层 |

**产品设计启示：** 跨仓 **Flow / Architecture** 页应优先引用 **契约与清单**，LLM 只填「为何、如何用」，并强制 `repo:id/...` 证据。

---

## 4. 聚合策略比较（决策表）

| 需求 | 更合适的聚合 | 原因 |
|------|--------------|------|
| 5–20 仓微服务，要改接口影响面 | C（契约图）+ 可选 A 叙事 | 边必须可机算 |
| 3–5 仓组成「一个产品」给新人读 | A 统一 wiki | 故事线优先 |
| 50–500 仓 org 级上下文给 agent | B hub + C 边 | 可缓存、可检索 |
| 产品对外文档多团队维护 | D Antora | 版本与所有权清晰 |
| 编码 agent 日常改代码 | repo-of-repos 工作区 + 短 plan | 读写分离 |

**混合（推荐的「产品级」栈）：**

1. **Freeze** Snapshot Set（钉 commit）  
2. **Per-repo card**（结构摘要 / 可选 `.arch` 等价物，可缓存）  
3. **Join** 边界（manifest、OpenAPI、启发式契约；有则上）  
4. **Plan** 覆盖每个 source + 跨仓 questions  
5. **Write** 统一 wiki：仓内 modules + 跨仓 flows + overview  
6. **Cite** 全程 `repo:id/path`

这正是 A+B+（轻量）C，而不是「一次 LLM 读完全部仓」。

---

## 5. 对本产品的设计含义

### 5.1 已对齐的好设计

- Snapshot Set + 命名 id + 钉修订（业界 workspace 共识）  
- 多源 citation 强制 id（Antora xref / 图节点 id 的叙事版）  
- 并行研究、单点写 wiki（RepoSwarm 并行 + hub 综合的同类）  
- 不把仓当可信执行（安全边界清晰）

### 5.2 相对竞品的空白

| 空白 | 竞品做法 | 建议方向 |
|------|----------|----------|
| Per-source plan 覆盖 | RepoSwarm 每仓必产出；RepoWise 每仓 index | Plan scout 按 `sourceId` 槽位 + coverage gate |
| 标准仓卡 | `.arch.md` 章节模板 | `analysis/sources/<id>.md` receipt，再进 Spec |
| 跨仓边 | contracts / system graph | 先轻量：OpenAPI/proto 路径清单 + Spec 级 `flows`；图可后置 |
| 增量 | commit+prompt 缓存 | Refresh 时按 source revision 跳过未变仓 |
| Agent 消费 | MCP / hub clone | 已有 wiki + 可加 workspace MCP；非必须先做 |

### 5.3 Wiki 信息架构建议（多仓）

```text
wiki/
  overview.md                 # 产品是什么、仓清单、怎么拼在一起
  architecture.md             # 运行时拓扑（跨仓）
  sources/                    # 或 modules/ 下按 id
    backend.md
    frontend.md
    shared.md
  flows/
    checkout.md               # 跨仓时序；多 repo: 引用
  contracts/                  # 可选：API/事件权威页
    public-api.md
```

**规则草案：**

- 每个 freeze source ≥ 1 概念页（或显式 non-critical 取消）  
- 每个跨仓 flow 的 citation 必须覆盖 **≥2 个 sourceId**（机械或 review lens）  
- Spec `domains` 优先按 **边界上下文**（checkout、identity），不必 1:1 等于 git 仓；但 **scope 字符串必须点名 source ids**

### 5.4 与「只跑多次单仓 wiki」的对比

| | N 次单仓 wiki | 1 次 Snapshot Set wiki |
|--|---------------|-------------------------|
| 仓内深度 | 易 | 需预算控制 |
| 跨仓故事 | 无 | 有（若 Plan 做好） |
| 成本 | N 倍 plan/write | 一次，但上下文更难 |
| 维护 | N 份漂移 | 一份，增量难 |

**结论：** 产品级叙事应用 **1 次多源 Run**；org 级广度用 **B hub**；二者可并存（hub 作 evidence，unified wiki 作读者入口）。

---

## 6. 最小可行多仓产品切片（研究建议）

不改总体 ADR 前提下，可验证：

1. **输入：** 2–3 仓 Snapshot Set（fe/be/lib）  
2. **Plan：** 强制 `analysis/plan-scouts/source-<id>.md`  
3. **Spec：** `pages[].sourceIds` 或 domain.scope 含 id；coverage gate  
4. **Write：** overview 必有「Repository map」表；至少一个 `flows/*` 跨两仓  
5. **Validate：** 多源 citation 格式；可选「跨仓 flow 多 id」检查  
6. **评测：** 人工 rubric：漏仓、错边、故事是否端到端  

图数据库与全量契约匹配可列为 **Phase 2**，避免在没有边界抽取前上重基础设施。

---

## 7. 参考链接

### 产品 / 开源

- OpenWiki: https://github.com/langchain-ai/openwiki · [Personal Brains](https://www.langchain.com/blog/introducing-openwiki-brains-general-purpose-wiki-memory-for-agents)  
- DeepWiki / Devin: https://deepwiki.com/ · https://docs.devin.ai/work-with-devin/deepwiki  
- Google Code Wiki: https://developers.googleblog.com/introducing-code-wiki-accelerating-your-code-understanding/  
- CodeWiki: https://github.com/FSoft-AI4Code/CodeWiki · https://arxiv.org/abs/2510.24428  
- RepoSwarm: https://github.com/reposwarm · [介绍](https://robotpaper.ai/reposwarm-give-ai-agents-context-across-all-your-repos/)  
- RepoWise workspaces: https://docs.repowise.dev/multi-repo/workspace-setup · https://docs.repowise.dev/multi-repo/cross-repo  
- DocuWriter: https://www.docuwriter.ai/  
- Antora multi-repo / distributed components: https://docs.antora.org/antora/latest/distributed-component-version/  
- repo-of-repos: https://www.raffertyuy.com/raztype/repo-of-repos-pattern/ · https://github.com/raffertyuy/repo-of-repos  
- Sourcegraph multi-repo search: https://sourcegraph.com/blog/multi-repo-search-how-to-search-across-multiple-repositories  

### 图 / 论文向

- Polyrepo code graph 实践: https://ryantsuji.dev/posts/code-graph-46-repos  
- LogicLens: https://arxiv.org/html/2601.10773v1  
- RepoDoc (KG → docs): https://arxiv.org/html/2604.26523v1  
- Harness「repo as knowledge graph」: https://www.harness.io/blog/your-repo-is-a-knowledge-graph-you-just-dont-query-it-yet  

### 本仓库

- ADR 0009 Repository Snapshot Set  
- `packages/skill/SKILL.md` 多源 citation  
- `docs/research/multi-source-plan-phase-bias-2026-08-03.md`  

---

## 8. 一句话

> **类似产品很多，但聚合策略分叉：统一叙事 wiki、每仓档案 hub、确定性跨仓图、文档站点装配。**  
> 同一项目多仓的正确设计通常是 **钉死 Snapshot Set → 并行 per-repo 证据/档案 → 确定性或半确定性跨仓边 → 单点合成端到端叙事并强制 `repo:id` 引用**。  
> open-okf-wiki 已有 Snapshot Set 与 citation 骨架；差距主要在 **per-repo 聚合层与跨仓边**，而不是再堆一个「更大的单次 Plan」。
