<!-- Hallmark · pre-emit critique: P5 H5 E5 S5 R4 V4 -->

# Beautiful UI 参考下的 Agent Workspace 前端优化分析

> Research note only. Not an ADR. 本文提取参考站的设计与交互 DNA，并给出一次 Agent Workspace 前端重构方案：允许替换 Shell、布局与展示组件，不做像素级复刻，也不改变 Session / WikiRun 的数据所有权。

- **研究日期：** 2026-07-30
- **仓库基线：** `master@3ff6f96` (`fix(workflow): content-only digests for seal prepare/verify`)
- **前端基线：** `packages/web@1b29b14` (`fix(web): session Active Run bar, drop right rail and forced inspector`)
- **参考站：** [Beautiful UI — Crafted primitives for AI-native interfaces](https://beautiful-ui-five.vercel.app/)
- **范围：** `packages/web/src/agent-workspace`、`AgentWorkspacePage`、`WorkbenchShell`、相关 i18n / tokens / 路由，以及现有 UX/UI 计划。

**证据边界：** 本轮直接检查了参考站公开 HTML/CSS，并用 Playwright 在桌面与移动端做了视觉采样；当前项目通过仓库现有 fixture server 实际跑通了空 Session、Plan Gate、Run Graph、Plan Details、明暗主题与移动端 Gate。当前仓库尚未把这些状态固化为可重复的视觉回归基线，因此本文同时给出 Wave 0 补强项。

---

## 执行结论

当前 Agent Workspace 不应继续做局部修补。数据与命令边界可以保留，但 Shell、布局和展示组件需要整体替换：

- `/w/:id` 已经是独立 Operate 工作台，Workspace / Wiki / Configure 使用单一顶栏；路由事实见 [`App.tsx:14`](../../packages/web/src/App.tsx#L14)。
- Operator Session 由 Pi Session SSE 投影；WikiRun 由 URL `?run=` 选择，Shell 只持有一个 active-run SSE；见 [`useSessionAgent.ts:95`](../../packages/web/src/agent-workspace/hooks/useSessionAgent.ts#L95) 与 [`WikiRunProjectionContext.tsx:39`](../../packages/web/src/agent-workspace/hooks/WikiRunProjectionContext.tsx#L39)。
- `ActiveRunBar` 已经收敛 HITL authority，这个所有权应保留；但 427 行的 Bar 同时承担 Run 切换、状态、Gate、表单、命令和详情开关，已经成为新的聚合瓶颈。

本方案采用**完整工作台重构**，目标不是给旧结构换皮，而是重建以下四个产品面：

1. **Session Navigator**：真正的可折叠 Sidebar，移动端自动转 Sheet，而不是手写 `aside`。
2. **Conversation Canvas**：统一 MessageScroller / Message / Bubble / Marker / Tool disclosure。
3. **Action Dock**：Gate 与 Composer 分成两个清晰区域，停止回答和停止 Run 不再混用。
4. **Run Cockpit**：按需出现、可调宽、URL 可恢复的 Run 观察与操作面，不是静态 Context Panel。

Beautiful UI 最值得借鉴的不是字体或卡片皮肤，而是以下交互语法：

> **状态先于日志；关键动作贴着状态；复杂信息按需展开；完成态收敛，异常态展开。**

实现上以仓库现有 `base-nova` shadcn 源码为主体，并通过官方 registry 增加 `resizable / item / accordion / drawer / progress`。允许新增和替换多个前端组件；不保留“尽量少改文件”的约束。Run graph、Gate command 和 SSE projection 仍是领域能力，不能由 shadcn 代替。

---

## 1. 参考站的设计 DNA

### 1.1 它是什么，不是什么

参考站自称是面向 AI-native interfaces 的小型组件库，公开目录包含 Loading State、Thinking、Streaming Text、Approval Card、Tool Chips、Task Rows、Chat、Context Cards、Diff Table、Sidebar Nav、Search 等组件。它是**交互原语展厅**，不是一个可直接照搬的 Agent 产品信息架构。[页面元信息与目录](https://beautiful-ui-five.vercel.app/)

因此，正确借鉴单位是“组件如何表达状态和动作”，而不是复制它的 288px 展厅侧栏、960px 画布或演示数据。

### 1.2 宏观结构

公开页面 HTML 显示：

- 桌面端为 `288px + minmax(0, 1fr)` 两栏，左侧 sticky 目录，右侧逐段展示组件；移动端转为纵向流。[页面结构](https://beautiful-ui-five.vercel.app/)
- 每个 section 都使用一致的“序号 + 名称 + 一句用途 + demo surface”节奏；不同组件内部结构各异，没有把所有内容都做成同一种 dashboard card。
- 背景、surface、field、line、ink 建立清晰层级；状态色只用于成功、警告、错误、选中和进行中。

对本项目的启示是：Workspace Shell 应稳定，Transcript / Gate / Run / Attempt 内部则应按对象性质采用不同结构。不要用更多 page-level card 补复杂度。

按 Hallmark 的结构词汇，参考站可归纳为：

| 轴 | 观察结果 |
|---|---|
| Macrostructure | **Component Playground**：交互预览是页面主体，每段展示一个可操作原语 |
| Navigation | **N3 Side-rail**：桌面 sticky 左栏，移动端回到文档流 |
| Footer | **Ft7 Newsletter-first**：更新订阅是收尾主动作 |
| Type | Inter 中性 grotesque 正文 + JetBrains Mono 标签 / 序号 |
| Surface | dark paper `#17181a`、canvas `#1c1d1f`、surface `#232427` |
| Accent | `#3d9aff`，小面积用于选中与主操作；绿色 / 橙色 / 红色只表达状态 |
| Motion | 无独立 motion library；CSS fade-up、shimmer、spin、collapse、短 scale feedback |
| Rhythm | 中等密度、左偏、section padding 一致；该项来自 Playwright 全页截图，不是仅靠 HTML 推断 |

### 1.3 视觉系统

参考站当前公开 CSS 使用 Inter + JetBrains Mono，`chip / control / card` 半径约为 `6 / 8 / 10px`，以 1px hairline、轻微阴影、近中性色 surface 为主，蓝色仅作交互 accent，绿色、橙色、红色表达语义状态。[公开 CSS 资产](https://beautiful-ui-five.vercel.app/_next/static/css/6143b371b3868592.css)

本项目已经具备等价基础，不需要替换：

- Geist / Geist Mono 已在 [`index.css:4`](../../packages/web/src/index.css#L4) 引入。
- semantic `success / warning / info / destructive` 已在 [`index.css:37`](../../packages/web/src/index.css#L37) 定义。
- shadcn、Base UI、Streamdown、Lucide、Resizable Panels 已安装；见 [`packages/web/package.json:16`](../../packages/web/package.json#L16)。

应迁移的是层级纪律，而不是把 Geist 换成 Inter，或复制参考站的具体 hex 值。

### 1.4 组件交互模式

#### Thinking

[Thinking](https://beautiful-ui-five.vercel.app/#thinking-state) 默认是一行“当前活动 + 展开箭头”，详情用竖线串起步骤；结束后可以收起。它让“模型正在做什么”先于完整 reasoning 文本。

#### Approval Card

[Approval Card](https://beautiful-ui-five.vercel.app/#approval-card) 一次聚焦一个问题，选项、自由输入、步骤位置和唯一推进动作在同一张卡内；次要导航降级为小图标。它避免把审批、日志、状态和调试信息同时摊开。

#### Tool Chips

[Tool Chips](https://beautiful-ui-five.vercel.app/#tool-chips) 先显示聚合摘要（工具调用数、消息数），再按需展开明细。完成态不持续占用正文空间。

#### Task Rows

[Task Rows](https://beautiful-ui-five.vercel.app/#task-rows) 每行用“状态图标 + 业务标题 + 结果摘要 + 状态标签 + 展开”表达任务。运行中、完成、等待的图形不同，展开后才显示子步骤和计数。这是最适合映射 Active Run 与 Run Node 的原语。

#### Chat

[Chat](https://beautiful-ui-five.vercel.app/#chat-composer) 将输入框和 Send 作为稳定主操作；上方状态/回复是内容，次要操作是图标。Composer 不承担整个 Agent runtime 的所有控制。

#### Context Cards 与 Diff Table

[Context Cards](https://beautiful-ui-five.vercel.app/#context-cards) 同时显示摘要、字符数和来源归属；[Diff Table](https://beautiful-ui-five.vercel.app/#diff-table) 用结构化差异和语义色表达变更，而不是先暴露原始 JSON / raw text。

### 1.5 动效原则

参考站使用 fade、shimmer、spin、collapse 和短暂 scale feedback，动效都绑定加载、流式输出、展开或状态变化。这个原则可以借鉴，但频率和强度不能照搬：真实操作台应仅让**正在运行的单一 playhead**运动，并提供 reduced-motion 退化。

---

## 2. 当前 Agent Workspace 架构

### 2.1 页面与状态流

```text
/w/:workspaceId?sessionId=&run=&attempt=
  AgentWorkspacePage
    ├─ workspace + sessions + recent runs bootstrap
    ├─ useSessionAgent(sessionId)            -> Pi Session SSE
    └─ WikiRunProjectionProvider(run)        -> one WikiRun SSE
         └─ AgentWorkspaceShell
              ├─ SessionList
              └─ Transcript
                   ├─ ThinkingBlock
                   ├─ AgentMarkdown
                   └─ ToolExecutionCard
              ├─ ActiveRunBar                -> sole HITL mutations
              ├─ ActiveRunDetails            -> plan / graph / attempt
              └─ Composer
```

证据：

- URL 契约写在 [`AgentWorkspacePage.tsx:1`](../../packages/web/src/pages/AgentWorkspacePage.tsx#L1)。
- Session stream 在 [`useSessionAgent.ts:171`](../../packages/web/src/agent-workspace/hooks/useSessionAgent.ts#L171) 创建原生 `EventSource`，首次 snapshot 后才进入 live。
- Run provider 明确只订阅 URL `?run=`，见 [`WikiRunProjectionContext.tsx:31`](../../packages/web/src/agent-workspace/hooks/WikiRunProjectionContext.tsx#L31)。
- Shell 中心顺序是 Transcript → ActiveRunBar → ActiveRunDetails → Composer，见 [`AgentWorkspaceShell.tsx:288`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx#L288)。
- `ActiveRunBar` 文件头明确声明它是 sole HITL decision surface，见 [`ActiveRunBar.tsx:1`](../../packages/web/src/agent-workspace/components/ActiveRunBar.tsx#L1)。

### 2.2 必须保留的是领域边界，不是当前布局组件

完整重构不等于推翻已经验证的数据流。下表区分“继续作为事实来源的领域能力”和“可以整体替换的前端表达”：

| 当前能力 | 重构决策 | 证据 |
|---|---|---|
| Session 与 Run 使用不同投影通道 | **保留。** UI 不合并两条 SSE，也不为视觉需要改写 server authority | [`WikiRunProjectionContext.tsx:2`](../../packages/web/src/agent-workspace/hooks/WikiRunProjectionContext.tsx#L2) |
| URL 使用 `sessionId / run / attempt` 选择工作台上下文 | **保留并补齐双向同步。** 新 Sidebar、Run Cockpit 与 Attempt Inspector 都服从 URL 契约 | [`AgentWorkspacePage.tsx:1`](../../packages/web/src/pages/AgentWorkspacePage.tsx#L1) |
| `ActiveRunBar` 是 sole HITL decision surface | **保留单一 command authority，替换组件。** 新 `GateAction` 承接 mutation，旧 Bar 不再作为 427 行聚合组件存在 | [`ActiveRunBar.tsx:1`](../../packages/web/src/agent-workspace/components/ActiveRunBar.tsx#L1) |
| Pi / WikiRun projection、gate command builder、run view-model | **保留领域逻辑与测试。** 允许调整 selector 输出以服务新视图，但不把 truth 复制进展示组件 | [`useSessionAgent.ts`](../../packages/web/src/agent-workspace/hooks/useSessionAgent.ts), [`wiki-run-view-model.ts`](../../packages/web/src/agent-workspace/run-graph/wiki-run-view-model.ts) |
| Assistant 正文无重 bubble、用户消息有明确 surface | **保留视觉原则，重组实现。** Transcript 全量采用 Message composition | [`Transcript.tsx:107`](../../packages/web/src/agent-workspace/transcript/Transcript.tsx#L107) |
| Thinking、tool summary、diff projection 已有可复用语义 | **保留内容逻辑，替换外壳。** 分别重组为 Collapsible、Item 与宽幅 diff surface | [`Transcript.tsx:35`](../../packages/web/src/agent-workspace/transcript/Transcript.tsx#L35), [`summary.ts`](../../packages/web/src/agent-workspace/components/tool-display/summary.ts) |
| 中英文 scaffold、Geist 字体与 semantic tokens | **保留并扩充。** 不另建主题系统，不复制参考站 hex | [`zh.ts:500`](../../packages/web/src/i18n/zh.ts#L500), [`index.css:65`](../../packages/web/src/index.css#L65) |

相反，`AgentWorkspaceShell`、`SessionList`、`ActiveRunBar`、`ActiveRunDetails`、`ToolExecutionCard`、手写 Run switcher、内联 Attempt Dialog 流程都只是当前呈现方式，不是兼容边界。它们应在新 Workbench 落地后退役或重组，而不是被逐层包进更多组件。

---

## 3. 当前状态审计

本节的 P0 / P1 / P2 表示问题影响级别，不代表后续继续按“小修优先级”实施；完整重构的实际交付顺序见第 8 节。

### 3.1 P0：业务状态不可扫描，内部实现词泄露

`StatusBadge` 对所有状态都使用相同 outline，并直接显示 raw `status`：[`StatusBadge.tsx:6`](../../packages/web/src/agent-workspace/components/StatusBadge.tsx#L6)。Active Run 首行和 Run switcher 菜单同样直接显示 raw state：[`ActiveRunBar.tsx:211`](../../packages/web/src/agent-workspace/components/ActiveRunBar.tsx#L211)、[`ActiveRunBar.tsx:230`](../../packages/web/src/agent-workspace/components/ActiveRunBar.tsx#L230)。这导致 `running`、`waiting_for_operator`、`published` 在视觉上没有稳定语义。

标准 UI 还暴露了实现细节：

- 空态直接解释 `wiki_produce`、`StartRun receipt` 和 `durable control plane`：[`zh.ts:533`](../../packages/web/src/i18n/zh.ts#L533)。
- Tool 行硬编码显示 `wiki_produce`：[`ToolExecutionCard.tsx:140`](../../packages/web/src/agent-workspace/components/ToolExecutionCard.tsx#L140)。

这些词适合 Debug 层，不适合首次使用路径。用户需要看到的是“生成 Wiki”“已开始生成”“等待你确认”“已发布”。

### 3.2 P0：Run 详情抢占 Transcript 高度

`ActiveRunDetails` 是中心列底部的 `shrink-0` 内联面板，最大高度为 `min(50vh, 28rem)`：[`ActiveRunDetails.tsx:114`](../../packages/web/src/agent-workspace/components/ActiveRunDetails.tsx#L114)。它上方还有 `ActiveRunBar`，下方还有 Composer，因此在 720px 高的笔记本或移动端会把 Transcript 压缩成很小区域。

本轮 fixture 实测：1440x900 展开 Plan Details 时 Transcript viewport 约为 `1216x286px`；390x844 等待 Plan 确认时，Active Run Bar 约 115px、Composer 约 131px，底部控制合计占 246px。问题不是页面级水平滚动，而是垂直工作区和信息优先级被控制面吃掉。

最新提交删除常驻右栏是合理的；问题不是“必须恢复右栏”，而是详情展示没有按 viewport 选择 dock / overlay / sheet。

### 3.3 P0：Run graph 不是 graph

实现注释明确说明“Layered chip grid only — no edge drawing”，父子关系只保存在 `parentKey`：[`RunGraphCanvas.tsx:1`](../../packages/web/src/agent-workspace/run-graph/RunGraphCanvas.tsx#L1)。view-model 也明确不投影 edges：[`view-model.ts:1`](../../packages/web/src/agent-workspace/run-graph/view-model.ts#L1)。

当前 UI 仅按 phase 渲染一或两列按钮，父节点只在 `title` 中通过 `← parentKey` 暗示：[`RunGraphCanvas.tsx:72`](../../packages/web/src/agent-workspace/run-graph/RunGraphCanvas.tsx#L72)。用户无法直接理解：

- 哪些 Domain / Leaf 属于同一父任务；
- 哪些节点并行；
- 哪个上游阻塞了 Writer / Review；
- retry 是同一节点的第几次 Attempt。

若暂时不画 edge，应诚实改名为“工作流 / 任务阶段”，并用缩进与 connector 显式表达 `parentKey`。若继续叫“运行图”，则必须把依赖关系画出来。

### 3.4 P0：Composer 与 Active Run 语义重复

Composer 同一 footer 内可能同时出现：Session Stop、Run Stop、context fill、model select、Run / Session status 和 Send；见 [`Composer.tsx:315`](../../packages/web/src/agent-workspace/composer/Composer.tsx#L315)。Run 状态与停止动作又已经在 `ActiveRunBar` 的语义范围内。

这会产生两个问题：

1. 用户难判断“停止”是停止当前回答，还是取消 durable Wiki Run。
2. 移动端一行内的控制数量不可控，输入不再是视觉主角。

### 3.5 P1：Session rail 信息不足且不可调宽

Session item 只显示标题与更新时间：[`SessionList.tsx:120`](../../packages/web/src/agent-workspace/session-list/SessionList.tsx#L120)。桌面 Pane 固定 `w-52 / md:w-56`：[`AgentWorkspaceShell.tsx:278`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx#L278)，尽管项目已经安装 `react-resizable-panels`：[`packages/web/package.json:34`](../../packages/web/package.json#L34)。

删除按钮使用 `opacity-0`，只在 hover / focus 时出现：[`SessionList.tsx:151`](../../packages/web/src/agent-workspace/session-list/SessionList.tsx#L151)。触屏或混合输入设备上发现性不足。

当前 UI 可以可靠补充的是活动 Session 的 `agentStatus`（idle / running / error）。URL `?run=` 独立选择 workspace Run，切换 Session 不会清理或重绑它：[`AgentWorkspacePage.tsx:51`](../../packages/web/src/pages/AgentWorkspacePage.tsx#L51)、[`AgentWorkspacePage.tsx:257`](../../packages/web/src/pages/AgentWorkspacePage.tsx#L257)；Run 列表 DTO 也没有 `sessionId`：[`wiki-runs.ts:18`](../../packages/web/src/api/wiki-runs.ts#L18)。因此可以独立显示当前选中 Run 的状态，但不能称它“关联当前 Session”。非活动 Session 更不应从时间或标题猜测状态。搜索与分组也应等 Session 数量证明需要后再加，不应预先扩建。

### 3.6 P1：连接状态主要依赖无限 Toast

Shell 对 reconnecting / offline 使用 `duration: Infinity` 的 Sonner toast：[`AgentWorkspaceShell.tsx:128`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx#L128)。页面内稳定节点仅为 `sr-only`：[`AgentWorkspaceShell.tsx:228`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx#L228)。

Toast 适合“状态发生变化”，不适合承载“当前数据是否实时”这一持续事实。连接异常时应在顶栏或 Active Run 保留紧凑、持久、非阻塞的 indicator；恢复 live 后可短暂 toast 提示。

### 3.7 P1：URL 状态与可见 UI 不完全一致

- URL 支持 `?attempt=`，但 `ActiveRunDetails` 只在本地 `graphOpen` 为 true 时挂载：[`AgentWorkspaceShell.tsx:121`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx#L121)、[`AgentWorkspaceShell.tsx:298`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx#L298)。直接刷新 attempt 深链时，dialog 逻辑可能根本未挂载。
- `AgentWorkspacePage` 每个 workspace id 只 boot 一次：[`AgentWorkspacePage.tsx:247`](../../packages/web/src/pages/AgentWorkspacePage.tsx#L247)。浏览器前进 / 后退或外部更新 `?sessionId=` 后，URL 与 `activeSessionId` 可能分离。

URL 是已公开的 workspace 状态契约，不应只在首次加载时生效。

### 3.8 P1：未知工具输出可能无法展开

未知工具若参数是短字符串，会被标记为 `headerOnly`：[`summary.ts:99`](../../packages/web/src/agent-workspace/components/tool-display/summary.ts#L99)。`ToolExecutionCard` 随后通过 `!display.headerOnly` 阻止展开，即使已有 output：[`ToolExecutionCard.tsx:90`](../../packages/web/src/agent-workspace/components/ToolExecutionCard.tsx#L90)。

产品原则应是：**任何存在 output / error 的工具都可展开**；`headerOnly` 只能表达“没有有用 body”，不能覆盖真实结果。

### 3.9 P1：Run switcher 自定义菜单可访问性不足

Run switcher 使用 absolute `<ul>` / button 组合：[`ActiveRunBar.tsx:217`](../../packages/web/src/agent-workspace/components/ActiveRunBar.tsx#L217)。它没有 menu / listbox 键盘模型、Escape、focus return 和 outside-click close。项目已有 Base UI / shadcn dropdown-menu，应复用现有 primitive。

### 3.10 P1：导航链接被错误声明为 Base UI Button

fixture server 的浏览器日志会重复出现 Base UI 语义告警：组件按原生 `<button>` 工作，但 `render` 最终生成了非 button 元素。根因是三个 Shell 都把路由链接交给 `Button.render`：[`WorkbenchShell.tsx:96`](../../packages/web/src/shells/WorkbenchShell.tsx#L96)、[`AppShell.tsx:56`](../../packages/web/src/shells/AppShell.tsx#L56)、[`AppShell.tsx:69`](../../packages/web/src/shells/AppShell.tsx#L69)、[`WikiReaderShell.tsx:47`](../../packages/web/src/shells/WikiReaderShell.tsx#L47)，而共享 `Button` 没有改变 Base UI 默认的 `nativeButton=true`：[`button.tsx:43`](../../packages/web/src/components/ui/button.tsx#L43)。

导航目标本质是链接，不应伪装成 button。优先让 `NavLink` 直接渲染 `<a>`，复用现有 `buttonVariants` 获得视觉样式；这样可保留链接的打开方式、键盘和浏览器原生语义。只有“非 button 元素确实要承担 button 行为”的其他场景，才使用 `nativeButton={false}`。[Base UI Button 文档](https://base-ui.com/react/components/button)也明确要求链接保留自己的语义，不应通过 Button 的 `render` prop 渲染。

### 3.11 P1：移动端双 Header 与 reduced-motion 缺口

`WorkbenchShell` 总会渲染顶栏：[`WorkbenchShell.tsx:70`](../../packages/web/src/shells/WorkbenchShell.tsx#L70)。Agent Shell 在 mobile 又渲染一个 workspace / sessions header：[`AgentWorkspaceShell.tsx:208`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx#L208)。首屏因此承担两层 header。

390x844 实测两层 header 分别约 44px 与 37px；第一层的 Agent / Wiki / Settings / Plan confirm 已出现拥挤和文字相互挤压。`body.scrollWidth === innerWidth` 只能证明没有横向滚动，不能证明导航仍然清晰可用。

Run playhead 对 running / awaiting 直接使用无限 `animate-pulse`：[`RunGraphCanvas.tsx:116`](../../packages/web/src/agent-workspace/run-graph/RunGraphCanvas.tsx#L116)，当前 `packages/web/src` 未定义 `prefers-reduced-motion` / `motion-reduce` 兜底。

### 3.12 P2：内容宽度与系统行层级不一致

Transcript 把正文、工具、diff、代码统一限制在 `max-w-3xl`：[`Transcript.tsx:271`](../../packages/web/src/agent-workspace/transcript/Transcript.tsx#L271)。正文窄列合理，但工具结果和 diff 需要更宽的可用面。

System / tool message 使用居中的普通 `<p>`，只有 aborted 才用 Marker：[`Transcript.tsx:78`](../../packages/web/src/agent-workspace/transcript/Transcript.tsx#L78)。相同语义对象应使用一致 marker 语言，减少“这是日志还是消息”的歧义。

---

## 4. 目标 Workbench 信息架构

### 4.1 从一条中心纵流改成四个协作面

新结构不是在旧 Shell 两侧补面板，而是把用户任务分成四个稳定产品面：

| 产品面 | 唯一职责 | 首层回答的问题 | 不应承担 |
|---|---|---|---|
| **Session Navigator** | 创建、选择和管理 Pi Session | “我正在和哪个 Session 协作？” | Run truth、Gate、工具日志 |
| **Conversation Canvas** | 阅读对话、thinking、tool result 与 system marker | “Agent 刚才做了什么、现在在说什么？” | durable Run 控制、全量调试元数据 |
| **Action Dock** | 展示当前 Run 摘要、唯一 Gate 决策和 Composer | “现在需要我输入、确认，还是等待？” | Run 图、Attempt 长日志、重复状态 |
| **Run Cockpit** | 观察 selected Run 的 Plan、Workflow、Attempt 与失败恢复 | “这次生成进行到哪里、为何阻塞、哪个节点失败？” | Session 导航、第二套 Gate mutation |

这四个面有不同的信息密度：Conversation 保持阅读性，Action Dock 保持决策聚焦，Run Cockpit 允许高密度扫描，Session Navigator 只做导航。不能再用同一种 Card 或同一个 Bar 承载它们。

### 4.2 Shell 所有权与目标组件树

`/w/:id` 的 Operate 页面由 `AgentWorkbench` **完整替换** `WorkbenchShell`，不能把 `SidebarProvider` 再嵌进现有 `WorkbenchShell`。原因是本地 Sidebar 使用 `min-h-svh` wrapper 与 `fixed inset-y-0 h-svh` desktop container；嵌套会覆盖原 Header、制造两个 full-height owner。Wiki 与 Configure 路由继续使用现有 Shell；Operate 的 Workspaces / Wiki / Configure 导航移入 SidebarFooter，workspace 名称、plan-confirm control、连接与 Run 入口移入 WorkspaceToolbar。

```text
AgentWorkbench                                      /w/:id route shell, h-svh owner
└─ GateActionController                             state + command owner
   └─ SidebarProvider
      ├─ AgentSessionSidebar                        Session Navigator
      │  ├─ SidebarHeader                           workspace + new session
      │  ├─ SidebarContent
      │  │  └─ SidebarMenu                          session rows + row actions
      │  ├─ SidebarFooter                           Workspaces / Wiki / Configure navigation
      │  └─ SidebarRail                             collapse affordance
      └─ SidebarInset
         ├─ WorkspaceToolbar
         │  ├─ SidebarTrigger + Breadcrumb
         │  ├─ SessionConnectionIndicator
         │  └─ RunPicker + RunInspectorTrigger
         ├─ ResizablePanelGroup                     wide desktop only
         │  ├─ ResizablePanel                       Conversation Canvas + Action Dock
         │  │  └─ ConversationPanel
         │  │     ├─ Transcript
         │  │     │  └─ MessageScroller
         │  │     │     ├─ Message / Bubble
         │  │     │     ├─ ThinkingDisclosure
         │  │     │     ├─ ToolExecutionGroup
         │  │     │     └─ Marker
         │  │     └─ ActionDock
         │  │        ├─ ActiveRunSummary
         │  │        ├─ GateActionHost              desktop: inline GateAction
         │  │        └─ Composer
         │  ├─ ResizableHandle                      desktop only
         │  └─ ResizablePanel                       contextual, closable
         │     └─ RunInspector                      Run Cockpit
         │        ├─ Tabs: Overview / Plan / Workflow / Attempts
         │        ├─ RunOverview
         │        ├─ PlanAccordion
         │        ├─ WorkflowView
         │        └─ AttemptInspector
         └─ ResponsiveOverlayHost                   tablet / mobile only
            ├─ Sheet                                tablet
            └─ Drawer                               mobile
               └─ RunInspector or sole GateAction
```

`RunInspector` 是 selected Run 的上下文面，不是被删除的 Sources / Runs / Wiki 静态第三栏。无 selected Run 或用户主动关闭时，它完全退出布局；`?attempt=` 存在时则自动打开并定位对应 Attempt。

`GateActionController` 位于响应式容器之上，持有 active gate、feedback / answer、submitting 与 command error。`GateActionHost` 只决定唯一 `GateAction` 挂载在哪里，不拥有第二份状态或 handler。

### 4.3 三档响应式结构

| 视口 | Session Navigator | Conversation / Action Dock | Run Cockpit | Gate |
|---|---|---|---|---|
| **宽桌面 `>= 1280px`** | shadcn Sidebar，expanded / icon collapse；宽度由 `--sidebar-width` 统一控制 | 中心为主面，正文窄列、tool surface 可放宽 | 与 Conversation 组成 `ResizablePanelGroup`，默认约 32%，可关闭 | 仍在 Action Dock；Cockpit 只解释上下文 |
| **平板 `768–1279px`** | Sidebar 可收为 icon rail | 保持全宽主任务面，不因 inspector 被压窄 | 右侧 `Sheet` overlay，关闭后 focus 回到触发器 | 长表单时把同一个 `GateAction` 移入 Sheet，原位只留摘要 |
| **移动 `< 768px`** | Sidebar 内建 mobile `Sheet`；顶栏只保留一个 Session 入口 | 单列；Composer 固定在安全区内，Run summary 在其上 | `Drawer` 从底部进入，可接近全高 | Gate 与 Inspector 共用 Drawer 容器，但同一时刻只挂载一个 `GateAction` |

首轮不实现 Session 列表的自由拖拽宽度。shadcn Sidebar 已提供 collapse、mobile Sheet、keyboard shortcut 和受控宽度变量；只有真实使用证明 16rem 固定宽度不足时，再给 `--sidebar-width` 增加 drag handle。`Resizable` 首轮只负责 Conversation / Run Cockpit，这是更稳定的布局边界。

### 4.4 关键交互流

1. **普通对话：** 选择 Session 后，Conversation Canvas 订阅该 Pi Session；Run Picker 的 URL 选择保持独立，不暗示二者关联。
2. **开始生成：** tool receipt 只在 Transcript 说明“已开始生成”；`ActiveRunSummary` 显示 selected Run 的真实状态，并提供打开 Cockpit 的入口。
3. **出现 Gate：** `GateActionHost` 抬升当前最紧迫的一个问题；宽桌面在 Action Dock 内联，平板 / 移动端由摘要打开 overlay。Run Cockpit 可同步显示依据，但不得再渲染一组 mutation CTA。
4. **检查失败：** 在 Workflow 选择节点后，同一 Cockpit 内更新 Attempt Inspector；只有需要阻断式输入时才打开 Dialog，避免 Dialog-on-Dialog。
5. **关闭与恢复：** 关闭 Cockpit 不清 `?run=`；关闭 Attempt 只清 `?attempt=`；浏览器前进 / 后退必须恢复 Session、Run、Inspector 和 Attempt 选择。

响应式 relocation 只移动组件挂载位置，不复制状态或 command handler：宽桌面在 Action Dock 挂载 `GateAction`；平板 / 移动端只在 Sheet / Drawer 挂载它，Action Dock 原位退化成只读摘要与打开入口。状态和 command owner 始终位于 host 之上，因此任一时刻只有一个 mutation surface。

### 4.5 Beautiful UI 原语到目标产品面的映射

| Beautiful UI 原语 | 目标产品面 / 组件 | 采用的 DNA | 本项目约束 |
|---|---|---|---|
| [Loading State](https://beautiful-ui-five.vercel.app/#loading-state) | Toolbar、Transcript、Run Inspector | 连接、等待事件、Agent 处理使用不同反馈 | 不把全部等待统一写成“思考中” |
| [Thinking](https://beautiful-ui-five.vercel.app/#thinking-state) | `ThinkingDisclosure` | 活动摘要优先，settled 后收起，步骤用竖线串联 | raw trace 不作为首层内容 |
| [Approval Card](https://beautiful-ui-five.vercel.app/#approval-card) | `GateAction` | 单问题、决策依据、唯一主动作处于同一决策区 | “Card”是交互模式名，不强制使用 shadcn Card |
| [Tool Chips](https://beautiful-ui-five.vercel.app/#tool-chips) | `ToolExecutionGroup` / `ToolExecutionItem` | settled 工具按 turn 聚合，异常项自动展开 | 任意 output / error 必须可见 |
| [Task Rows](https://beautiful-ui-five.vercel.app/#task-rows) | `ActiveRunSummary`、Workflow、Session rows | 状态图标 + 业务标题 + 摘要 + 状态 + 详情 | 状态、计数和进度只能来自 contract |
| [Chat](https://beautiful-ui-five.vercel.app/#chat-composer) | Conversation Canvas + Composer | Assistant 低 chrome、用户有 bubble、输入贴底 | Run stop 不进入 Composer |
| [Context Cards](https://beautiful-ui-five.vercel.app/#context-cards) | Run Overview / Attempt Inspector | 摘要、来源和 scope 先于 raw metadata | context 按需进入 Cockpit，不常驻 |
| [Diff Table](https://beautiful-ui-five.vercel.app/#diff-table) | tool 宽幅 `DiffPreview` | 结构化 add / remove 与路径摘要 | 与 prose 使用不同 max-width |
| [Sidebar Nav](https://beautiful-ui-five.vercel.app/#sidebar-nav) | `AgentSessionSidebar` | 稳定导航、active state、可发现行尾动作 | 非活动 Session 不推断运行状态 |
| [Search](https://beautiful-ui-five.vercel.app/#search) | Composer `Command` | slash command 可筛选、可键盘操作 | 不预建没有规模证据的全局 Session 搜索 |

---

## 5. shadcn 组件策略

### 5.1 项目事实

在 `packages/web` 执行 `pnpm dlx shadcn@latest info --json`，当前项目为：

| 配置 | 当前值 | 对方案的影响 |
|---|---|---|
| Framework | Vite + React 19 | `rsc=false`，不添加 Next.js / RSC 约定 |
| Tailwind | v4，入口为 `src/index.css` | 所有 token 修改只进入现有全局 CSS，不新建第二套主题文件 |
| shadcn style | `base-nova` | 延续现有视觉与源码风格，不切 preset |
| Primitive base | Base UI | 组合使用 `render`，不是 Radix 的 `asChild`；非 button 元素必须保留正确语义 |
| Icon library | Lucide | 所有新图标来自 `lucide-react`，Button 内图标使用 `data-icon` |
| 已安装 | 34 个 UI 组件 | 先重组已有源码，再新增 registry 项 |
| 现有依赖 | `@base-ui/react`、`react-resizable-panels`、`@shadcn/react` | 新布局和 chat 不需要第二套依赖 |

### 5.2 已安装组件：直接复用

| 领域 | shadcn 组件 | 目标组合 |
|---|---|---|
| 工作台与导航 | `SidebarProvider`、`Sidebar`、`SidebarInset`、`SidebarMenu*`、`SidebarRail`、`Sheet`、`Breadcrumb` | `AgentSessionSidebar`、mobile Session Sheet、唯一 Workspace Toolbar |
| Conversation | `MessageScroller*`、`Message*`、`Bubble*`、`Marker` | Transcript 的滚动、锚定、jump-to-latest、用户 bubble、system rows |
| Composer / Gate 表单 | `Field`、`FieldGroup`、`InputGroup`、`InputGroupTextarea`、`Select`、`Command`、`Button` | Composer、slash command、feedback / operator input、model select |
| Run 导航 | `Tabs`、`DropdownMenu`、`Collapsible` | Cockpit 视图、Run Picker、Thinking / tool disclosure |
| 状态与反馈 | `Badge`、`Alert`、`Spinner`、`Skeleton`、`Empty`、`sonner` | 状态语义、持续异常、加载、空态、瞬时反馈 |
| 辅助交互 | `Tooltip`、`Dialog`、`AlertDialog`、`ScrollArea`、`Separator` | icon action、阻断式 Attempt 任务、删除确认、面板内部滚动与分隔 |

当前 `Transcript` 已使用 `MessageScroller / Bubble / Marker` 的一部分，但还没有完整使用 `Message / MessageGroup / MessageContent`。重构应完成组合，不能因为“已经 import”就视为迁移结束。

本地 UI 源码有两处必须保留的项目补丁：`message-scroller.tsx` 增加了 `min-w-0 / w-full` 以防宽内容撑开，`bubble.tsx` 允许代码和工具结果横向滚动。它们不得在 registry 更新时被覆盖。

### 5.3 官方 registry：新增组件

| 组件 | 是否纳入 | 用途 | 使用约束 |
|---|---|---|---|
| [`resizable`](https://ui.shadcn.com/docs/components/base/resizable) | **必须** | 宽桌面 Conversation / Run Cockpit 双栏 | 只用于主内容与 Cockpit；平板和移动端改为 overlay |
| [`item`](https://ui.shadcn.com/docs/components/base/item) | **必须** | Run、Tool、Plan page、Workflow node、Failed node 的扫描行 | 领域组件组合 Item；不把业务逻辑放进 `components/ui/item.tsx` |
| [`accordion`](https://ui.shadcn.com/docs/components/base/accordion) | **必须** | Plan domain / page、workflow stage 分组 | 项目是 Base UI，`defaultValue` 使用数组，不照抄 Radix API |
| [`drawer`](https://ui.shadcn.com/docs/components/base/drawer) | **必须** | 移动端 Run Cockpit 与 Gate 聚焦面 | 必须有 `DrawerTitle`；验证 iOS Safari safe area 与 body 定位 |
| [`progress`](https://ui.shadcn.com/docs/components/base/progress) | **条件必须** | 真实的页面完成数、节点完成数、context fill | 没有稳定分母就不渲染，不用时间模拟进度 |
| `toggle-group` | **暂缓安装** | 未来 2–5 个真实视图过滤器 | 当前 Tabs 已覆盖 Cockpit 视图；出现明确过滤需求再加 |

一次性 dry-run：

```bash
pnpm dlx shadcn@latest add resizable item accordion drawer progress toggle-group --dry-run
```

CLI 会创建 7 个文件，同时提出覆盖现有 `separator.tsx`。因此实际实施时必须逐个组件执行 `--dry-run`，再对每个受影响文件执行 `--diff`；不批量执行，不使用 `--overwrite`。`message-scroller`、`message`、`bubble`、`marker` 已安装，不重新 add。

### 5.4 明确不新增

| 组件 / 依赖 | 本轮不采用的原因 | 何时再评估 |
|---|---|---|
| `attachment` | 当前消息和 Composer contract 没有附件生命周期 | contract 提供上传、处理、错误与持久化状态后 |
| `avatar` | `PiSessionSummary` 没有可靠用户 / Agent identity | 产品有稳定身份数据与 fallback 规则后 |
| `popover` / `hover-card` | DropdownMenu、Tooltip、Dialog 已覆盖现有场景 | 出现独立的小型 contextual content 需求后 |
| 第二套 AI UI library | 已有 shadcn chat primitives 和项目领域组件 | 现有 primitives 无法覆盖真实能力且有测量证据后 |
| React Flow | 当前是只读工作流，已有 view-model 与 SVG 先例 | 需要复杂拖拽编辑、缩放、自动布局时 |

### 5.5 shadcn 组合规则

1. **Sidebar 是导航，不是装饰 rail。** Session row 使用 `SidebarMenuItem + SidebarMenuButton + SidebarMenuAction`，创建 Session 放 `SidebarHeader`，移动端复用 Sidebar 内建 Sheet。
2. **Conversation 使用 chat primitives 的固定嵌套。** `MessageScrollerProvider -> MessageScroller -> MessageScrollerViewport -> MessageScrollerContent -> MessageScrollerItem -> Message -> MessageContent -> Bubble`；`MessageScrollerButton` 位于 MessageScroller 内、Viewport 之后。不再手写 raw scroll 容器或 stick-to-bottom hook，也不把 `MessageScrollerItem` 与通用 `Item` 混用。
3. **Composer 与 Gate 使用完整 Field composition。** `FieldGroup + Field` 承担 label、description、invalid / disabled；`InputGroup` 内只放 `InputGroupInput / InputGroupTextarea` 与 `InputGroupAddon`。
4. **列表项必须位于 Group 内。** `CommandItem` 进入 `CommandGroup`，`SelectItem` 进入 `SelectGroup`，`DropdownMenuItem` 进入 `DropdownMenuGroup`，Run / Tool / Node 的通用 `Item` 进入 `ItemGroup`，`TabsTrigger` 只能进入 `TabsList`。
5. **Overlay 必须有标题并管理 focus。** `SheetTitle / DrawerTitle / DialogTitle` 不可省略；关闭后 focus 回到触发器，不能手写 z-index。
6. **Base UI 保留最终元素语义。** 路由导航直接渲染 anchor 并复用 `buttonVariants`；确需 `render` 到非 button 元素时显式处理 `nativeButton={false}`。
7. **语义 token 优先。** 状态使用 Badge variant 或现有 `success / warning / info / destructive` token；不在 JSX 写 raw green / red / blue，不另写 dark override。
8. **Lucide 图标服从组件尺寸。** Button / Menu / Alert 内不手写图标 `size-*`，status descriptor 传组件对象而不是字符串 icon key；icon-only action 必须同时具备 accessible name 与 Tooltip。
9. **Base UI 表单使用 Base API。** `Select` root 必须传 `items={models}`；invalid 同时设置 `Field data-invalid` 与 control `aria-invalid`，disabled 同时设置 `Field data-disabled` 与 control `disabled`。Composer 重写时修正当前遗漏，不照搬现状。
10. **Sidebar 的屏幕阅读文案必须本地化。** `SidebarTrigger / SidebarRail` 传入本地化 accessible name，并给本地 Sidebar 源码暴露可配置的 mobile `SheetTitle / SheetDescription`，不能继续朗读硬编码英文。

### 5.6 Card 不是默认容器

Beautiful UI 的 “Approval Card” 描述的是决策结构，不意味着应机械使用 shadcn `Card`。以下区域保持 flat pane 或专用原语：

- Workspace Shell、Sidebar、Toolbar、Conversation、Composer 和 Run Cockpit 外壳；
- Message、system Marker、Tool rows、Run rows、Plan rows 与 Workflow graph；
- Sheet / Drawer / Dialog 内部，以及 Empty、loading、error 状态。

对应组合分别是 `Sidebar`、`Message / Bubble`、`InputGroup`、`Item`、语义化 `section / form + Field`、`Tabs / Accordion`、`Drawer / Dialog`、`Empty / Skeleton`。`Alert` 只承载 Gate 到达提示、错误或警告，不包住整个交互表单。只有“可独立搬走、需要完整 header/content/footer 边界”的上下文对象才考虑 Card；本轮核心工作台不需要新增 Card。

## 6. 领域组件重组与行为规格

### 6.1 Run、Gate 与 Workflow

#### 状态语义

先复用已经存在的 `t.runStatus` 文案（[`en.ts:517`](../../packages/web/src/i18n/en.ts#L517)、[`zh.ts:500`](../../packages/web/src/i18n/zh.ts#L500)），再补一个小型 tone / icon 映射。每个状态只提供：

- 本地化业务标签；
- semantic tone；
- 图标；
- 是否需要运动；
- 可选的 operator action 语气。

示例：

| 内部状态 / 词 | 默认产品文案 | Debug 层 |
|---|---|---|
| `wiki_produce` | 生成 Wiki | 保留 tool name |
| `running` | 生成中 | raw state |
| `waiting_for_operator` | 等待你确认 | gate kind / id |
| `published` | 已发布 | run id / revision |
| `failed` | 生成失败 | error / attempt id |
| `StartRun receipt` | 已开始生成 | receipt payload |

不要为状态建立新的 design system；一个映射函数和现有 Badge / icon 足够。

#### Active Run 拆成 Summary 与 Cockpit

默认 Active Run 行参考 Task Rows：

```text
[状态图标] 正在撰写 Wiki      8 / 12 页      [生成中] [详情]
```

只有 contract 提供真实计数时才显示 `8 / 12`，不得编造进度。

详情策略与第 4 节保持一致：

- 宽屏：按需出现的 Run dock / resizable pane；关闭后完全释放空间。
- 中等屏：右侧 Sheet overlay，不重新压缩 Transcript。
- 移动端：接近全高的 bottom Drawer。
- `?attempt=` 存在时自动打开详情并定位 Attempt。

不恢复永久的 Sources / Runs / Wiki stub rail。这里的 pane 是**当前 Run context**，不是第三套导航。

#### GateAction 采用单问题、单决策区

Plan / Publication / Fix / Operator Input 应共享同一信息节奏：

1. 当前需要用户决定什么；
2. 决策依据摘要；
3. 主动作与次动作；
4. feedback / answer 仅在需要时展开；
5. technical metadata 折叠。

`GateAction` 继承 `ActiveRunBar` 的 sole mutation authority；Run Cockpit 只负责解释、选择 node / attempt 和触发已有 retry / rerun command，不在 Transcript tool item 或 Cockpit tab 中复制 Gate CTA。

#### WorkflowView 显示真实关系

目标实现：

1. view-model 把每个真实 `parentKey` 投影为只读 edge，并保留 phase / layer 分组。
2. Workflow 主视图使用轻量 SVG connector 表达已知父子关系；窄屏退化为带缩进和竖向 connector 的 Item tree。
3. 节点行显示业务角色、摘要、状态、attempt 次数；唯一 running playhead 同时使用图标与文本，不只靠颜色。
4. 选中节点在同一 Cockpit 更新 Attempt Inspector，取消常规路径中的大 Dialog。
5. contract 没有提供的 cross-phase dependency 不绘制、不猜测；UI 明确区分“父子关系”和“调度顺序”。

不引入 React Flow。仓库已有依赖无关的 SVG graph 可复用布局和 accessibility 思路：[`WikiGraphView.tsx:165`](../../packages/web/src/wiki/WikiGraphView.tsx#L165)。

### 6.2 Conversation、Session 与连接

#### Composer 收回到对话输入职责

- 保留当前 streaming 时的 `steer` 发送能力；输入为空时可让主操作位切换为“停止回答”，有输入时 Send 仍发送 `steer`，停止回答降为紧凑的独立动作。当前 Web 的分支只有 active turn → `steer`、否则 → `prompt`：[`useSessionAgent.ts:270`](../../packages/web/src/agent-workspace/hooks/useSessionAgent.ts#L270)。
- `follow_up` 目前只有 contract / server 能力（[`agent-protocol.ts:35`](../../packages/contract/src/agent-protocol.ts#L35)、[`session-runtime.ts:353`](../../packages/server/src/agent-session/session-runtime.ts#L353)），Web 没有调度入口；若未来需要 queue，应作为独立功能补显式模式、文案和测试，而不是把它假定为本轮重构前已有能力。
- “停止运行”移动到 Active Run，并明确这是取消 durable Run。
- Run 状态只在 Active Run 展示，不在 Composer 重复。
- Model / Context 放入次级控制区；Context 仅在接近阈值时主动显著。
- 保留 `/command`，但不和 Run 控制混在同一视觉组。

#### AgentSessionSidebar 重建导航

- 活动 Session 使用现有 `agentStatus` 显示 idle / running / error；URL 选中的 Run 状态继续在 Active Run 独立显示，不把两者标成关联对象。
- `PiSessionSummary` 目前只有 `id / title / updatedAt`（[`agent-protocol.ts:218`](../../packages/contract/src/agent-protocol.ts#L218)），`WikiRunListItem` 也没有 `sessionId`，因此任何 Session row 都不虚构 Run 关联；非活动 Session 也不推断状态。只有未来契约明确提供事实时再补。
- 使用 shadcn Sidebar 的 expanded / icon collapse、keyboard shortcut、mobile Sheet 和统一 16rem 宽度 token；不保留手写 `aside` / rail 状态机。
- 删除进入始终可发现的 row actions menu；触屏无需 hover。
- 只有在会话数量和检索成本真实增长后再加搜索 / 分组。

#### 连接状态进入稳定页面节点

- 顶栏或 Active Run 放一个不抢注意力的 connection indicator。
- reconnecting / offline 持续可见，并说明数据可能不是实时。
- toast 仅用于状态切换；live 恢复后自动清除。
- Session connection 与 Run connection 可在详情中区分，但首层只在异常时暴露差异。

#### URL 与 UI 双向同步

- `?sessionId=` 变化时同步 active session，并验证 id 是否存在。
- `?run=` 继续只决定订阅对象，不强制详情常开。
- `?attempt=` 则意味着详情必须打开，并在 snapshot ready 后选中 attempt。
- 关闭 Attempt 仅清 `attempt`，关闭详情不清 `run`，保持当前语义。

#### Tool progressive disclosure

- 任意 output / error 均允许展开。
- done + settled 默认收起；running / error / awaiting 自动打开。
- 连续 settled tool calls 按一个 assistant turn 聚合为摘要。
- `read / grep / ls` 显示路径与结果；`write / edit` 显示 diff；未知工具使用可折叠 pretty fallback。
- 技术 tool name 在 Debug 可见，首层使用产品动作名称。

#### 导航链接恢复原生链接语义

- `WorkbenchShell`、`AppShell`、`WikiReaderShell` 的 `NavLink` / `Link` 直接渲染为 `<a>`，通过现有 `buttonVariants` 复用外观，不再包进 Base UI `Button`。
- 保留链接的 `href`、新标签页 / 复制链接等浏览器行为，以及 Tab / Enter 键盘模型。
- 对其他 `Button render` 调用按最终元素复核 `nativeButton`，但不为这一问题新增 wrapper 或组件库。

### 6.3 视觉、密度与动效

- 正文维持约 42rem 阅读宽度；tool / diff surface 可占满中心 pane。
- 所有 system / tool system row 使用统一 Marker 语言。
- Run switcher 改用已有 DropdownMenu / Select primitive，补齐键盘与 focus 管理。
- 合并移动端双 Header，Session Sheet 入口进入唯一 `WorkspaceToolbar`。
- running playhead 使用单一、轻微动效；增加 `motion-reduce` / `prefers-reduced-motion`。
- 统一 6–10px 控件 / card 半径、hairline 与 semantic color，但不复制参考站具体 token 值。

### 6.4 当前组件退役 / 重组矩阵

| 当前文件 / 组件 | 目标处理 | 新职责 / 去向 | 保留内容 |
|---|---|---|---|
| `AgentWorkspaceShell` | **替换** | `AgentWorkbench` 只负责编排 Sidebar、Toolbar、Conversation、Action Dock 与 Cockpit | props 中的真实 Session / Run command wiring 分流到各领域组件 |
| `SessionList` | **替换** | `AgentSessionSidebar` 使用 Sidebar primitives | title / updatedAt 格式化、create / select / delete callback |
| `PaneCollapseButton` | **删除或内联退役** | `SidebarTrigger / SidebarRail` 接管 | 无独立领域逻辑 |
| `ActiveRunBar` | **拆分后退役** | `ActiveRunSummary + RunPicker + GateActionController / Host` | primary gate selection、command CAS / error handling、sole mutation authority |
| `ActiveRunDetails` | **替换** | `RunInspector`，desktop panel / tablet Sheet / mobile Drawer 共用内容 | spec fetch、selected Run projection、URL attempt 恢复 |
| `StatusBadge` | **替换** | `RunStatusBadge` 使用本地化 status descriptor | Badge primitive；不保留 raw string passthrough |
| `ToolExecutionCard` | **替换** | `ToolExecutionGroup + ToolExecutionItem` 使用 Item / Collapsible | `summary.ts`、DiffPreview、status glyph 与 unknown fallback |
| `Transcript` | **重组** | 完整 Message composition，按 message 类型分 renderer | AgentMarkdown、Thinking 内容、现有 projection |
| `Composer` | **重写 presentation** | `Field + InputGroup + Command + Select` | prompt / steer / abort dispatch、model callback、context calculation |
| `RunGraphCanvas` | **替换** | `WorkflowView`：desktop SVG edge view + narrow Item tree | `wikiRunToViewModel` 的 node / attempt 投影，新增真实 parent edges |
| `NodeAttemptDialog` | **拆分** | `AttemptInspector` 内联 Cockpit；仅阻断式任务保留精简 Dialog | transcript fetch、attempt message projection、node actions |
| `FailedNodesList` | **重组** | Workflow / Attempts tab 中的 `FailedNodeItem` | retry eligibility 与 command wiring |
| `SpecReviewView` | **重组** | `PlanAccordion` 使用 Accordion + Item | spec 业务内容与问题列表 |
| `FixGatePanel` / `WikiProduceGatePanel` | **并入统一框架** | `GateAction` 按 gate kind 选择内容 renderer | command builder、校验、gate-specific copy |

“替换”指旧 presentation 组件在迁移完成后不再挂载；不是要求同一个提交先删除文件。领域 selector、command builder 和对应测试先保留，待新组件通过行为与视觉回归后再删除无调用的旧外壳。

---

## 7. 边界与明确不采用项

1. **不复制参考站的展厅信息架构。** 288px sticky component nav 服务于组件目录，不适合 Operator Session。
2. **不复制大量 11–12px 字号。** 中文主要状态和正文应保持当前 13–14px 可读层级；2xs 只用于时间、id 和辅助计数。
3. **不复制持续 shimmer / pulse。** 真实运行可能持续数十分钟，长时间动效会制造疲劳；仅 active playhead 运动。
4. **不复制演示指标。** 页面数、百分比、耗时和 confidence 必须来自 contract，不为“更像参考站”而编造。
5. **不恢复旧静态第三栏。** 最新提交删除无 live binding 的 ContextPanels 是正确收敛；需要的是按需 Run context。
6. **不把所有内容做成卡片。** Transcript、Gate、system marker、工作流 connector 和 inspector 外壳都保持 unframed；优先使用 Message、Item、Alert、Tabs、Accordion 与 flat pane。
7. **不引入 React Flow 或第二套 AI UI 库。** 当前 CSS、SVG、shadcn / Base UI 与 Resizable Panels 足够完成第一轮。
8. **不改变 Session / Run authority。** 视觉优化不能合并 Pi Session SSE 与 durable WikiRun SSE，也不能在浏览器重建 workflow truth。

---

## 8. 完整重构迁移波次

这是结构级替换，不是微调清单；但也不应把数据流、视图和命令一次性全部改完。每一波都交付新架构中的完整纵向切片，旧 presentation 只在对应新切片通过后退役。

### Wave 0：锁定契约、fixtures 与 registry 输入

本轮已经用现有 fixture server 采样了空 Session、Plan Gate、Run Details 和明暗 / 移动端状态。Wave 0 要把一次性审计升级成仓库内可重复的 fixtures / e2e state：

- 空 Session；
- streaming + thinking；
- tool running / done / error；
- active Run；
- Plan / Publication / Fix / Operator Input gate；
- failed node + retry；
- published；
- reconnecting / offline。

在 1440×900、1280×720、768×1024、414×896、375×812、320×568 保存基线截图，并记录 DOM overflow / console error。当前仓库没有持久化的 Agent Workspace 视觉基线，不能把本轮 `/tmp` 审计截图当作回归测试。

同时完成三项准备：

1. 把 Session SSE、WikiRun SSE、URL query、Gate command 与现有 selector 测试列为不可破坏契约。
2. 逐个 dry-run / diff 并添加 `resizable / item / accordion / drawer / progress`；保留 `message-scroller / bubble` 的本地行为补丁，并拒绝批量解析对 `separator` 提出的非必要覆盖。
3. 建立 Run status descriptor 与中英文文案；所有新视图从同一 descriptor 读取 label、tone、icon 和 motion policy。

### Wave 1：替换 Workbench Frame 与 Session Navigator

1. 让 `AgentWorkbench` 完整接管 Operate route shell，用 `SidebarProvider / Sidebar / SidebarInset` 同时取代 `WorkbenchShell` 的 Operate 外壳、手写 desktop aside 和 mobile Session Sheet。
2. 新建 `WorkspaceToolbar`，成为唯一 Header，放置 Breadcrumb、plan-confirm control、connection indicator、Run Picker 和 inspector trigger。
3. 新建 `AgentSessionSidebar`，迁移 create / select / delete；row action 对 touch、keyboard 与 pointer 都可发现。
4. 修正 `WorkbenchShell / AppShell / WikiReaderShell` 的 anchor 语义，消除 Base UI `nativeButton` 告警。
5. 保持旧 Transcript / ActiveRun / Composer 暂时作为中心槽内容，先验证 Shell 尺寸、导航、URL 与 SSE 不回归。

退出条件：桌面与移动端只存在一个 Workspace Toolbar，Sidebar 切换不重建 SSE，浏览器前进 / 后退能同步 Session 选择。

### Wave 2：重建 Conversation Canvas

1. Transcript 迁移到完整 `MessageScroller / Message / Bubble / Marker` 组合，保留现有 message projection 与 AgentMarkdown。
2. `ThinkingDisclosure` 接管 thinking，活动态展开、settled 态收起；system / aborted / tool-system 统一 Marker 语法。
3. `ToolExecutionGroup / Item` 接管 tool 展示，settled tools 按 assistant turn 聚合；running / awaiting / error 保持展开。
4. 分离 prose measure 与 tool / diff width，验证超长路径、代码块、中文长词和 unknown output。
5. 使用 Skeleton / Empty / Alert 重建 loading、empty 与 error，不保留自制状态框。

退出条件：streaming 自动跟随、用户向上滚动不被抢回、jump-to-latest 可用；任意有 output / error 的工具可展开。

### Wave 3：重建 Action Dock 与唯一 GateAction

1. 将 `ActiveRunBar` 拆成 `ActiveRunSummary / RunPicker / GateAction`，command authority 只迁移一次。
2. `GateActionController / Host` 用语义化 `section / form + FieldGroup + Field + InputGroup / RadioGroup + Button` 统一 Plan、Publication、Fix、Operator Input 的节奏；`Alert` 仅用于到达提示、错误或警告。
3. Composer 重写为 `Field + InputGroup + Command + Select`；保留 prompt / steer / abort，移除 Run stop 和重复 Run status。
4. Session abort 与 durable Run cancel 使用不同标签、图标和位置；pending command 使用 Spinner + disabled，不假定 Button 有 loading prop。
5. `follow_up` 不进入 UI，直到 Web 有明确 dispatch、队列状态与测试。

退出条件：页面任一时刻只有一个 Gate mutation surface；“停止回答”和“取消生成”不会出现在同一 control group。

### Wave 4：建立 Run Cockpit

1. 新建 `RunInspector` 与 Overview / Plan / Workflow / Attempts Tabs；所有 TabsTrigger 进入 TabsList，内容进入 TabsContent。
2. desktop 用 `ResizablePanelGroup`，tablet 用右侧 Sheet，mobile 用 Drawer；三者渲染同一 inspector content，不复制业务分支。
3. `PlanAccordion` 组合 domain / page Item；`WorkflowView` 投影真实 parent edges；narrow viewport 使用 Item tree fallback。
4. `AttemptInspector` 接管节点选择、transcript 与 node command；`?attempt=` 自动打开正确容器并在 snapshot ready 后定位。
5. failed / retry / rerun 只依据当前 snapshot 的 generation、attempt id 与 eligibility 显示，不从视觉状态推断。
6. Progress 只有在 snapshot 提供稳定完成数 / 总数时出现；否则使用阶段标签与 Spinner。

退出条件：1280×720 展开 Cockpit 时 Conversation 仍可用；320px Drawer 无溢出；Workflow 的已知 parent 关系不依赖 hover title。

### Wave 5：切换、退役与全量 QA

1. 将 `AgentWorkspacePage` 的 presentation 入口切到新 Workbench，移除旧组件调用；只有确认无调用后才删除旧外壳文件。
2. 运行 unit、typecheck、lint、e2e 与视觉截图；验证 keyboard、focus、screen reader label、reduced motion、长中文、超长路径、断线重连与 720px 高度。
3. 在 320 / 375 / 414 / 768px 验证无页面级水平滚动、无双 Header、无两行按钮 / tab 标签、触摸目标不小于 44px。
4. 在 1280×720 与 1440×900 验证 Sidebar collapse、Cockpit resize / close、Transcript anchoring 和 Composer safe area。
5. 清理旧 i18n key、无调用 presentation helper 与临时兼容 props；不删除仍被 selector / command tests 覆盖的领域逻辑。

最终切换是 presentation hard cut：不长期保留“旧 UI / 新 UI”产品开关，也不维护两套 Workbench。

---

## 9. 验收标准

### 9.1 架构与状态所有权

- [ ] 每个 Workspace 仍只有一个选中 Session 的 Pi SSE 和一个选中 Run 的 WikiRun SSE。
- [ ] Gate 决策只有一个 `GateAction` mutation surface；它继承旧 `ActiveRunBar` authority，tool receipt 与 Run Cockpit 不复制 CTA。
- [ ] 浏览器不持久化或推断 durable Run truth。
- [ ] `?sessionId=`、`?run=`、`?attempt=` 与 UI 双向同步；关闭 Run Cockpit 不清 `?run=`，关闭 Attempt 只清 `?attempt=`。
- [ ] Session row 不把 URL-selected Run 描述为关联对象；切换 Session 不重绑或清理 selected Run。
- [ ] 新 presentation 继续复用现有 projection、CAS command 与 retry eligibility，不在组件本地复制 durable truth。
- [ ] Operate route 只有 `AgentWorkbench` 一个 `h-svh` / Header owner；它不再嵌套 `WorkbenchShell`，Wiki / Configure 路由不受影响。

### 9.2 产品语言与扫描效率

- [ ] 标准 UI 不出现 `wiki_produce`、`StartRun receipt`、`durable control plane`、raw snake_case state；Debug 除外。
- [ ] running / awaiting / success / failed / cancelled 在图标、标签和 semantic tone 上可区分，且中英文一致。
- [ ] Active Run 首层在一行或两行内回答：正在做什么、当前结果/阶段、是否需要我操作。
- [ ] 所有计数和进度都来自 contract；无虚构百分比、耗时或 confidence。

### 9.3 shadcn 组合质量

- [ ] Session Navigator 使用 `SidebarProvider / Sidebar / SidebarInset / SidebarMenu*`，不再保留手写 desktop aside 与第二套 mobile Sheet。
- [ ] Transcript 使用完整 MessageScroller 与 Message composition；没有自制 stick-to-bottom、scroll math 或重复 jump-to-latest 状态。
- [ ] Composer / Gate 使用 `FieldGroup + Field`；InputGroup 内只使用 `InputGroupInput / InputGroupTextarea / InputGroupAddon`；invalid / disabled 的 Field 与 control 属性成对出现。
- [ ] Base UI Select root 传 `items`；SelectItem、DropdownMenuItem、CommandItem 分别位于对应 Group，TabsTrigger 位于 TabsList。
- [ ] Transcript 使用准确的 MessageScroller 固定嵌套，`MessageScrollerButton` 位于 root 内、Viewport 之后。
- [ ] Run / Tool / Node / Plan rows 使用通用 Item composition，不与 `MessageScrollerItem` 混淆。
- [ ] Sheet、Drawer、Dialog 都有可访问 Title；overlay 不写手工 z-index，关闭后 focus 返回触发器。
- [ ] Base UI trigger 使用 `render` 而不是 `asChild`；最终为 anchor 的导航保留原生链接语义。
- [ ] registry 更新经过逐项 `--dry-run / --diff`；`message-scroller / bubble` 本地行为补丁没有被覆盖，批量解析提出的 `separator` 差异未被盲目接受。
- [ ] Sidebar trigger、rail、mobile Sheet Title / Description 使用当前语言的本地化文案，不朗读硬编码英文。
- [ ] Workspace、Conversation、Gate、Cockpit 和列表没有被机械包成 Card wall。

### 9.4 布局与响应式

- [ ] 1280×720 打开 Run Cockpit 时，Conversation 与 Cockpit 通过 Resizable 横向分栏，两侧内容都保持可操作。
- [ ] `768–1279px` Run Cockpit 使用右侧 Sheet；`<768px` 使用 bottom Drawer，Composer 与 overlay 不重叠。
- [ ] 320 / 375 / 414 / 768px 无页面级水平滚动、按钮 / tab / breadcrumb 两行换行、文字截断或双 Header。
- [ ] Sidebar 可 expanded / icon collapse；状态持久化不改变 Session 或 Run 订阅，中心列始终 `min-w-0`。
- [ ] prose 维持可读窄列，tool / diff 可使用更宽 surface。
- [ ] mobile 使用 `svh / dvh` 和 safe-area padding；不使用 `100vw` 制造滚动条溢出。
- [ ] touch surface 的关键操作目标至少 44×44 CSS px；hover-only action 有 focus / tap 等价入口。

### 9.5 Run / Gate / Workflow

- [ ] Gate 首层只有一个清晰问题和一个主决策区；feedback / metadata 按需展开。
- [ ] 每个节点的真实 `parentKey` 关系无需 hover title 即可辨认；contract 未提供的 dependency 不被绘制或推断。
- [ ] running playhead 唯一且明显；reduced-motion 下不 pulse。
- [ ] attempt 次数、失败状态与 retry / rerun eligibility 对应真实 snapshot。
- [ ] 节点选择更新同一详情上下文，不产生 Dialog-on-Dialog。
- [ ] desktop SVG view 与 narrow Item tree 表达同一 node / edge / selection 状态，键盘也能选择节点。
- [ ] Progress 只在稳定分母存在时渲染，并提供可读文本；没有分母时使用阶段状态而非伪百分比。

### 9.6 Composer、Session 与 Tool

- [ ] “停止回答”与“停止运行”不在 Composer 同时竞争；streaming `steer` 仍可用，且文案不会混淆作用域；不把 `follow_up` 当作现有 Web 能力。
- [ ] Session row 显示标题、更新时间；活动 Session 显示真实 agent 状态，非活动 Session 不推断状态；任何 Session row 都不把 URL 选中的 Run 虚构为关联对象；行尾操作在 touch / keyboard 可发现。
- [ ] 任意带 output / error 的 unknown tool 可展开。
- [ ] done tools 可聚合；running / error / awaiting tools 不被聚合隐藏。
- [ ] system / aborted / tool-system message 使用一致 Marker 语法。
- [ ] streaming follow 在用户停留 live edge 时工作；用户向上阅读后不会被强制拉回，并可使用 jump-to-latest。

### 9.7 连接、状态与可访问性

- [ ] reconnecting / offline 在页面内持续可见，不依赖 Infinity toast。
- [ ] Run switcher 支持 Arrow、Enter / Space、Escape、outside click、focus return。
- [ ] 导航仍渲染为带 `href` 的原生链接，Tab / Enter、复制链接和新标签页行为正常。
- [ ] 所有 icon-only action 有 accessible name 与 tooltip。
- [ ] 键盘 focus 不被 Sheet / Drawer / Dropdown 丢失。
- [ ] default / hover / focus / active / disabled / loading / error / success 状态按实际适用范围完整；error / success 不只依赖颜色。
- [ ] focus ring 立即出现且对比度足够；`prefers-reduced-motion` 下空间动效退化为不超过 150ms 的 opacity 或完全静止。
- [ ] async connection、command 和 streaming 状态通过恰当的 `aria-live` 传达，不在每个 token 更新时重复播报。
- [ ] Playwright 在桌面与移动端无 console error、Base UI 元素语义告警，并有关键状态截图断言。

### 9.8 迁移完成度与回归

- [ ] 新 Workbench 已成为唯一 production presentation；不存在长期“双 UI”开关或两套 Shell 状态机。
- [ ] `AgentWorkspaceShell / ActiveRunBar / ActiveRunDetails / SessionList / RunGraphCanvas` 等旧外壳无调用后才删除；领域 helper 与测试按实际调用保留。
- [ ] unit、typecheck、lint、e2e 全部通过；fixture 覆盖 empty、streaming、tool error、四类 gate、failed retry、published、reconnecting / offline。
- [ ] 1440×900、1280×720、768×1024、414×896、375×812、320×568 的关键截图已审阅，无内容重叠、空白 canvas 或不可达操作。

---

## 10. 与既有 UX/UI 计划的关系

现有 [`ux-ui-refactor-plan-2026-07.md`](../design/ux-ui-refactor-plan-2026-07.md) 提出的产品原则仍然成立：

- Chat 是 control surface，Wiki 是 product，多 Agent 是 nested observation：[`plan:10`](../design/ux-ui-refactor-plan-2026-07.md#L10)。
- 正文窄、tool surface 可更宽；HITL sticky；见 [`plan:203`](../design/ux-ui-refactor-plan-2026-07.md#L203)。
- Run graph 应有 edge 或清晰父子层级：[`plan:259`](../design/ux-ui-refactor-plan-2026-07.md#L259)。
- Session 应有状态、可调宽，并保留 mobile Sheet：[`plan:273`](../design/ux-ui-refactor-plan-2026-07.md#L273)。

但该文档头部明确标记为 `plan only — not implemented`：[`plan:1`](../design/ux-ui-refactor-plan-2026-07.md#L1)，而 `1b29b14` 已经用 ActiveRunBar 替代常驻右栏。本方案不是继续完成旧计划的剩余小项，而是用当前代码事实重新落地其产品原则：

| 决策 | 既有方向 | 本方案调整 |
|---|---|---|
| 页面结构 | Chat + Context 的多栏工作台 | Session Sidebar + Conversation / Action Dock + contextual Run Cockpit |
| Run 详情 | 容易被理解为常驻第三栏 | selected Run 存在时按需打开；desktop Resizable、tablet Sheet、mobile Drawer |
| HITL | sticky、靠近当前 Run | 保留 sole authority，但拆掉聚合 `ActiveRunBar`，由统一 `GateAction` 承接 |
| Session pane | 可调宽 + mobile Sheet | 首轮采用 Sidebar expanded / icon collapse + 内建 mobile Sheet；真实证据出现后再加自由拖拽 |
| Run graph | edge 或清晰父子层级 | 对已有 `parentKey` 画真实 edge；窄屏退化为 connector tree，不猜测未知 dependency |
| 组件策略 | 原则层描述 | 明确以 `base-nova` shadcn 组合为实现基座，并列出 registry 输入与覆盖保护 |
| 迁移方式 | plan only | 按 Wave 0–5 完成结构替换后进行 presentation hard cut，不长期保留两套 UI |

最终方向仍是“Run 必须是一等对象”，但它是一等**上下文**，不是永久占宽的一等**栏位**。

---

## 11. 一手来源

### 外部参考

1. [Beautiful UI 首页与公开组件目录](https://beautiful-ui-five.vercel.app/) — 页面定位、宏观结构、组件清单，访问于 2026-07-30。
2. [Thinking](https://beautiful-ui-five.vercel.app/#thinking-state) — 可展开活动轨迹。
3. [Approval Card](https://beautiful-ui-five.vercel.app/#approval-card) — Human-in-the-loop 单问题决策卡。
4. [Tool Chips](https://beautiful-ui-five.vercel.app/#tool-chips) — 工具调用聚合与渐进展开。
5. [Task Rows](https://beautiful-ui-five.vercel.app/#task-rows) — running / failed / completed 任务行。
6. [Chat](https://beautiful-ui-five.vercel.app/#chat-composer) — Chat 与 Composer 层级。
7. [Context Cards](https://beautiful-ui-five.vercel.app/#context-cards) — 检索摘要与来源归属。
8. [Diff Table](https://beautiful-ui-five.vercel.app/#diff-table) — 结构化变更表达。
9. [Sidebar Nav](https://beautiful-ui-five.vercel.app/#sidebar-nav) 与 [Search](https://beautiful-ui-five.vercel.app/#search) — 导航与检索原语。
10. [参考站公开 CSS 资产](https://beautiful-ui-five.vercel.app/_next/static/css/6143b371b3868592.css) — 字体、radius、surface、semantic color 与 motion token，访问于 2026-07-30；hashed URL 可能随部署变化。
11. [Base UI Button](https://base-ui.com/react/components/button) — `nativeButton` 与 `render` 的元素语义约束；链接应保留原生 anchor 语义，访问于 2026-07-30。
12. [shadcn Sidebar](https://ui.shadcn.com/docs/components/base/sidebar) — SidebarProvider、SidebarInset、mobile Sheet 与 collapse composition。
13. [shadcn Resizable](https://ui.shadcn.com/docs/components/base/resizable) — desktop panel group 与 handle composition。
14. [shadcn Item](https://ui.shadcn.com/docs/components/base/item) — 扫描型 list row 的 media / content / action 结构。
15. [shadcn Input Group](https://ui.shadcn.com/docs/components/base/input-group) — Composer 内输入、addon 与 action composition。
16. [shadcn Command](https://ui.shadcn.com/docs/components/base/command) — slash command 的筛选与键盘模型。
17. [shadcn Tabs](https://ui.shadcn.com/docs/components/base/tabs) — Run Cockpit 的多视图导航。
18. [shadcn Sheet](https://ui.shadcn.com/docs/components/base/sheet) — tablet inspector 与 Sidebar mobile overlay 基础。
19. [shadcn Drawer](https://ui.shadcn.com/docs/components/base/drawer) — mobile-first bottom panel 与 Drawer title / content composition。
20. [shadcn Accordion](https://ui.shadcn.com/docs/components/base/accordion) — Plan 与 Workflow 分组；本项目使用 Base UI API。
21. [shadcn Progress](https://ui.shadcn.com/docs/components/base/progress) — 仅在有真实 value / denominator 时表达进度。
22. [shadcn CLI](https://ui.shadcn.com/docs/cli) — project info、registry add、dry-run 与 diff 工作流。

### 当前仓库

1. [`App.tsx`](../../packages/web/src/App.tsx) — 当前 route map。
2. [`AgentWorkspacePage.tsx`](../../packages/web/src/pages/AgentWorkspacePage.tsx) — workspace bootstrap、URL session / run / attempt contract。
3. [`AgentWorkspaceShell.tsx`](../../packages/web/src/agent-workspace/AgentWorkspaceShell.tsx) — Session / Transcript / Active Run / Composer 布局与 connection toast。
4. [`useSessionAgent.ts`](../../packages/web/src/agent-workspace/hooks/useSessionAgent.ts) — Pi Session SSE 与 connection status。
5. [`WikiRunProjectionContext.tsx`](../../packages/web/src/agent-workspace/hooks/WikiRunProjectionContext.tsx) — 单 active-run projection。
6. [`ActiveRunBar.tsx`](../../packages/web/src/agent-workspace/components/ActiveRunBar.tsx) — HITL、Run switcher 与 graph toggle。
7. [`ActiveRunDetails.tsx`](../../packages/web/src/agent-workspace/components/ActiveRunDetails.tsx) — inline plan / graph / Attempt details。
8. [`RunGraphCanvas.tsx`](../../packages/web/src/agent-workspace/run-graph/RunGraphCanvas.tsx) 与 [`view-model.ts`](../../packages/web/src/agent-workspace/run-graph/view-model.ts) — 当前 layered chip grid 与 parentKey。
9. [`Composer.tsx`](../../packages/web/src/agent-workspace/composer/Composer.tsx) — Session / Run / context / model / send controls。
10. [`SessionList.tsx`](../../packages/web/src/agent-workspace/session-list/SessionList.tsx) — Session row 与 hover-only delete。
11. [`Transcript.tsx`](../../packages/web/src/agent-workspace/transcript/Transcript.tsx) — Thinking、Message、Marker 与统一 max-width。
12. [`ToolExecutionCard.tsx`](../../packages/web/src/agent-workspace/components/ToolExecutionCard.tsx) 与 [`summary.ts`](../../packages/web/src/agent-workspace/components/tool-display/summary.ts) — tool progressive disclosure。
13. [`zh.ts`](../../packages/web/src/i18n/zh.ts)、[`en.ts`](../../packages/web/src/i18n/en.ts)、[`index.css`](../../packages/web/src/index.css) — 产品文案、字体与 semantic tokens。
14. [`WorkbenchShell.tsx`](../../packages/web/src/shells/WorkbenchShell.tsx)、[`AppShell.tsx`](../../packages/web/src/shells/AppShell.tsx)、[`WikiReaderShell.tsx`](../../packages/web/src/shells/WikiReaderShell.tsx) 与 [`button.tsx`](../../packages/web/src/components/ui/button.tsx) — 导航链接、共享 Button 外观与 Base UI 元素语义。
15. [`Operator Web UX/UI Full Refactor Plan`](../design/ux-ui-refactor-plan-2026-07.md) — 既有设计意图；仅作方向背景，不当作当前实现事实。
