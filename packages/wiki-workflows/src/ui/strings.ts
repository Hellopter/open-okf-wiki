export type WikiUiLanguage = "zh" | "en";

export interface WikiUiStrings {
  language: WikiUiLanguage;
  panelTitle: (count: number) => string;
  panelHint: string;
  panelTerminalHint: string;
  noRun: string;
  runsTitle: string;
  runsEmpty: string;
  runsEmptyDetail: string;
  loadingRun: string;
  loadingRunDetail: string;
  stagesTitle: string;
  agentsTitle: (stage: string, count: number) => string;
  noAgents: string;
  notScheduled: string;
  conditional: string;
  notStarted: string;
  helpTitle: string;
  statusLine: (status: string, running: number, failed: number) => string;
  startedNotify: (mode: string) => string;
  openHint: string;
  cancelTitle: string;
  cancelMessage: string;
  deleteTitle: string;
  deleteMessage: string;
  retryAgentTitle: (label: string) => string;
  retryPhaseTitle: (title: string) => string;
  retryKeepUpstream: (list: string) => string;
  retryRerun: (list: string) => string;
  retryGit: string;
  retryWritesWiki: string;
  retryNoWikiWrite: string;
  selectAgentRetry: string;
  waitAgentSettle: string;
  selectStageRetry: string;
  stageNotScheduled: (title: string) => string;
  waitPhaseSettle: string;
  selectActivePause: string;
  onlyRunningPause: string;
  noActiveCancel: string;
  onlyCompletedDelete: string;
  currentRunCannotDelete: string;
  returnToRunsDelete: string;
  footerRuns: string;
  footerDashboardStages: string;
  footerDashboardAgents: string;
  footerAgentCompact: string;
  footerAgentPager: string;
  footerHelp: string;
  footerConfirm: string;
  active: string;
  fork: string;
  follow: string;
  compact: string;
  pager: string;
  // Agent view chrome
  agentTitle: (label: string) => string;
  agentArchived: string;
  agentAttempt: (attempt: number, suffix: string) => string;
  failure: string;
  latestOutput: string;
  noCompletedOutput: string;
  messagesTitle: string;
  noMessagesYet: string;
  latestAssistantOutput: string;
  execution: string;
  noExecutionMetrics: string;
  markdownHandoff: string;
  controlSubmission: string;
  nodeResult: string;
  noNodeResult: string;
  requiredSubmission: (tool: string) => string;
  errorPrefix: (message: string) => string;
  compactHint: string;
  // Help body lines
  helpRuns: string;
  helpDashboard: string;
  helpAgent: string;
  helpGlobal: string;
}

const EN: WikiUiStrings = {
  language: "en",
  panelTitle: (count) => `Wiki running (${count}):`,
  panelHint: "  /wiki open — open navigator",
  panelTerminalHint: "  /wiki open — open navigator (finished run kept until next generate/refresh)",
  noRun: "Wiki: no run",
  runsTitle: "Wiki Runs",
  runsEmpty: "No Wiki generation history yet.",
  runsEmptyDetail: "Start with /wiki generate or /wiki refresh.",
  loadingRun: "Loading Wiki run",
  loadingRunDetail: "The selected history is being loaded.",
  stagesTitle: "Stages",
  agentsTitle: (stage, count) => `${stage} · ${count} agents`,
  noAgents: "No agents scheduled yet.",
  notScheduled: "not started",
  conditional: "conditional",
  notStarted: "not started",
  helpTitle: "Wiki Run Controls",
  statusLine: (status, running, failed) =>
    `Wiki ${status} | ${running} running${failed ? ` | ${failed} failed` : ""}`,
  startedNotify: (mode) => `Started ${mode} Wiki run. Use /wiki open to watch progress.`,
  openHint: "/wiki open",
  cancelTitle: "Cancel Wiki Run?",
  cancelMessage: "Running agents will be aborted; completed output remains readable.",
  deleteTitle: "Delete Wiki History?",
  deleteMessage: "The saved run record will be removed. Git files and generated Wiki pages are unchanged.",
  retryAgentTitle: (label) => `Retry ${label}?`,
  retryPhaseTitle: (title) => `Retry ${title}?`,
  retryKeepUpstream: (list) => `Keep upstream: ${list}`,
  retryRerun: (list) => `Re-run: ${list}`,
  retryGit: "Git: will be re-checked before retry.",
  retryWritesWiki: "This retry can write wiki/.",
  retryNoWikiWrite: "This retry does not write wiki/ directly.",
  selectAgentRetry: "Open a stage and select an agent to retry",
  waitAgentSettle: "Wait for the selected agent to settle before retrying",
  selectStageRetry: "Select a stage before retrying it",
  stageNotScheduled: (title) => `${title} has not been scheduled yet`,
  waitPhaseSettle: "Wait for running agents in the selected stage to settle before retrying it",
  selectActivePause: "Select the active Wiki run to pause or resume",
  onlyRunningPause: "Only a running or paused run can be paused",
  noActiveCancel: "No active Wiki run to cancel",
  onlyCompletedDelete: "Only inactive completed history can be deleted",
  currentRunCannotDelete: "The current Wiki run remains in this session; start another run before deleting its history.",
  returnToRunsDelete: "Return to the Wiki run list to delete history",
  footerRuns: "j/k runs · Enter open · x delete · q close · ? help",
  footerDashboardStages: "j/k stages · Tab/l agents · Enter agent · R retry stage · Esc runs · q close",
  footerDashboardAgents: "j/k agents · Tab/h stages · Enter detail · r retry · Esc runs · q close",
  footerAgentCompact: "Enter pager · r retry · [/] attempts · Esc dashboard · q close · ? help",
  footerAgentPager: "j/k scroll · f follow · [/] attempts · Esc compact · q close · ? help",
  footerHelp: "Esc/? close help · q close navigator",
  footerConfirm: "Enter confirm · Esc cancel",
  active: "active",
  fork: "fork",
  follow: "follow",
  compact: "compact",
  pager: "pager",
  agentTitle: (label) => `Agent: ${label}`,
  agentArchived: " (archived)",
  agentAttempt: (attempt, suffix) => `attempt ${attempt}${suffix}`,
  failure: "Failure",
  latestOutput: "Latest output",
  noCompletedOutput: "No completed output yet.",
  messagesTitle: "Messages & tool calls",
  noMessagesYet: "No completed message or tool call recorded yet.",
  latestAssistantOutput: "Latest assistant output",
  execution: "Execution",
  noExecutionMetrics: "No execution metrics reported.",
  markdownHandoff: "Markdown handoff",
  controlSubmission: "Control submission",
  nodeResult: "Node result",
  noNodeResult: "No node result recorded.",
  requiredSubmission: (tool) => `Required submission: ${tool}`,
  errorPrefix: (message) => `Error: ${message}`,
  compactHint: "Enter opens pager",
  helpRuns: "Runs: j/k select · Enter open dashboard · x delete completed history",
  helpDashboard: "Dashboard: timeline · left stages · right agents · Tab/h/l switch pane",
  helpAgent: "Agent: compact by default · Enter pager · f follow · [/] attempts",
  helpGlobal: "Esc back · q close · p pause/resume · c cancel · r retry agent · R retry stage · ? help",
};

const ZH: WikiUiStrings = {
  language: "zh",
  panelTitle: (count) => `Wiki 运行中 (${count})：`,
  panelHint: "  /wiki open — 打开导航器",
  panelTerminalHint: "  /wiki open — 打开导航器（完成的运行会保留到下次 generate/refresh）",
  noRun: "Wiki：无运行",
  runsTitle: "Wiki 运行记录",
  runsEmpty: "尚无 Wiki 生成历史。",
  runsEmptyDetail: "使用 /wiki generate 或 /wiki refresh 开始。",
  loadingRun: "正在加载 Wiki 运行",
  loadingRunDetail: "正在加载所选历史记录。",
  stagesTitle: "阶段",
  agentsTitle: (stage, count) => `${stage} · ${count} 个代理`,
  noAgents: "尚未调度代理。",
  notScheduled: "未开始",
  conditional: "条件性",
  notStarted: "未开始",
  helpTitle: "Wiki 运行控制",
  statusLine: (status, running, failed) =>
    `Wiki ${status} | ${running} 运行中${failed ? ` | ${failed} 失败` : ""}`,
  startedNotify: (mode) => `已启动 ${mode} Wiki 运行。使用 /wiki open 查看进度。`,
  openHint: "/wiki open",
  cancelTitle: "取消 Wiki 运行？",
  cancelMessage: "正在运行的代理将被中止；已完成输出仍可读。",
  deleteTitle: "删除 Wiki 历史？",
  deleteMessage: "将删除已保存的运行记录。Git 文件与生成的 Wiki 页面不受影响。",
  retryAgentTitle: (label) => `重试 ${label}？`,
  retryPhaseTitle: (title) => `重试 ${title}？`,
  retryKeepUpstream: (list) => `保留上游：${list}`,
  retryRerun: (list) => `重新运行：${list}`,
  retryGit: "Git：重试前会重新检查。",
  retryWritesWiki: "此次重试可能写入 wiki/。",
  retryNoWikiWrite: "此次重试不会直接写入 wiki/。",
  selectAgentRetry: "打开阶段并选择要重试的代理",
  waitAgentSettle: "请等待所选代理结束后再重试",
  selectStageRetry: "请先选择要重试的阶段",
  stageNotScheduled: (title) => `${title} 尚未调度`,
  waitPhaseSettle: "请等待该阶段运行中的代理结束后再重试",
  selectActivePause: "请选择活动的 Wiki 运行以暂停或恢复",
  onlyRunningPause: "仅运行中或已暂停的运行可暂停",
  noActiveCancel: "没有可取消的活动 Wiki 运行",
  onlyCompletedDelete: "仅可删除非活动的已完成历史",
  currentRunCannotDelete: "当前 Wiki 运行仍保留在此会话中；请先启动下一次运行再删除其历史。",
  returnToRunsDelete: "请返回运行列表删除历史",
  footerRuns: "j/k 选择 · Enter 打开 · x 删除 · q 关闭 · ? 帮助",
  footerDashboardStages: "j/k 阶段 · Tab/l 代理 · Enter 代理 · R 重试阶段 · Esc 列表 · q 关闭",
  footerDashboardAgents: "j/k 代理 · Tab/h 阶段 · Enter 详情 · r 重试 · Esc 列表 · q 关闭",
  footerAgentCompact: "Enter 分页 · r 重试 · [/] 尝试 · Esc 仪表盘 · q 关闭 · ? 帮助",
  footerAgentPager: "j/k 滚动 · f 跟随 · [/] 尝试 · Esc 摘要 · q 关闭 · ? 帮助",
  footerHelp: "Esc/? 关闭帮助 · q 关闭导航器",
  footerConfirm: "Enter 确认 · Esc 取消",
  active: "活动",
  fork: "分支",
  follow: "跟随",
  compact: "摘要",
  pager: "分页",
  agentTitle: (label) => `代理：${label}`,
  agentArchived: "（已归档）",
  agentAttempt: (attempt, suffix) => `尝试 ${attempt}${suffix}`,
  failure: "失败",
  latestOutput: "最新输出",
  noCompletedOutput: "尚无完成输出。",
  messagesTitle: "消息与工具调用",
  noMessagesYet: "尚无已完成的消息或工具调用记录。",
  latestAssistantOutput: "最新助手输出",
  execution: "执行",
  noExecutionMetrics: "暂无执行指标。",
  markdownHandoff: "Markdown 交接",
  controlSubmission: "控制提交",
  nodeResult: "节点结果",
  noNodeResult: "尚无节点结果记录。",
  requiredSubmission: (tool) => `需要提交：${tool}`,
  errorPrefix: (message) => `错误：${message}`,
  compactHint: "Enter 打开分页",
  helpRuns: "运行列表：j/k 选择 · Enter 打开仪表盘 · x 删除已完成历史",
  helpDashboard: "仪表盘：时间线 · 左阶段 · 右代理 · Tab/h/l 切换面板",
  helpAgent: "代理：默认摘要 · Enter 分页 · f 跟随 · [/] 尝试",
  helpGlobal: "Esc 返回 · q 关闭 · p 暂停/恢复 · c 取消 · r 重试代理 · R 重试阶段 · ? 帮助",
};

export function uiStrings(language: WikiUiLanguage | undefined): WikiUiStrings {
  return language === "zh" ? ZH : EN;
}
