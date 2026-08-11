export * from "./types.js";
export { inspectWiki } from "./inspect.js";
export { finalizeWiki, validateWiki } from "./validate.js";
export {
  createWikiArtifactStore,
  MAX_WIKI_ARTIFACT_BYTES,
  MAX_WIKI_JSON_ARTIFACT_BYTES,
  MAX_WIKI_RESEARCH_ARTIFACT_BYTES,
  type WikiArtifactKind,
  type WikiArtifactLocation,
  type WikiArtifactRef,
  type WikiArtifactStore,
  type WikiArtifactStoreOptions,
  type WikiArtifactWrite,
} from "./artifact-store.js";
export {
  addWikiSource,
  DEFAULT_SOURCE_IGNORES,
  directoryLinkType,
  ensureWikiWorkspaceInternalIgnore,
  initializeWikiWorkspace,
  loadWikiWorkspace,
  sourceIsIgnored,
  wikiWorkspaceService,
  type AddWikiSourceRequest,
  type InitializeWikiWorkspaceRequest,
  type ResolvedWikiSource,
  type ResolvedWikiWorkspace,
  type WikiWorkspace,
  type WikiWorkspaceResult,
  type WikiWorkspaceService,
  type WikiWorkspaceSource,
} from "./workspace.js";
export {
  CORRECTION_MAX,
  createPiAgentExecutor,
  PiAgentExecutor,
  SALVAGE_MAX,
  type PiAgentExecutorOptions,
} from "./executor.js";
export {
  WikiAgentContextBudgetError,
  WikiAgentProtocolError,
  isContextBudgetMessage,
  type SubmissionFailure,
  type SubmissionFailureCode,
  type SubmissionToolName,
  type WikiAgentErrorCode,
} from "./agent-errors.js";
export {
  createWikiWorkflowEngine,
  WikiWorkflowEngine,
  type WikiWorkflowEngineOptions,
} from "./engine.js";
export { checkRunArtifactHealth } from "./run-health.js";
export {
  createWikiRunSession,
  isWikiRunSession,
  parseWikiRunSession,
  WIKI_RUN_CUSTOM_TYPE,
  WIKI_RUN_POINTER_VERSION,
} from "./session.js";
export {
  explainWikiRunSnapshot,
  isWikiRunSnapshot,
  parseWikiRunSnapshot,
} from "./snapshot-validation.js";
export {
  WikiCheckpointCoordinator,
  type CheckpointOptions,
  type CheckpointSinks,
} from "./checkpoint.js";
export {
  createWikiRunHistoryStore,
  DEFAULT_MAX_TERMINAL_WIKI_RUNS,
  summarizeWikiRun,
  wikiHistoryProjectKey,
  type WikiRunHistoryStore,
  type WikiRunHistoryStoreOptions,
} from "./run-history.js";
export {
  createWikiExtension,
  default as wikiExtension,
  type WikiExtensionOptions,
} from "./extension.js";

// Dual-track UI public API
export {
  openWikiNavigator,
  openWikiRunNavigator,
  renderWikiNavigatorFrame,
  type OpenWikiNavigatorOptions,
} from "./ui/navigator.js";
export {
  createWikiUiHost,
  WikiUiHost,
  notifyRunStarted,
  type WikiUiHostBindOptions,
} from "./ui/host.js";
export {
  renderPanel,
  statusLine,
  installTaskPanel,
  clearTaskPanel,
  createTaskPanelWidget,
  TASK_PANEL_KEY,
  STATUS_KEY,
  type TaskPanelSnapshot,
  type ProgressMode,
} from "./ui/task-panel.js";
export {
  renderWikiRunText,
  renderWikiRunHistoryText,
  renderWikiArtifactText,
  renderWikiResultDelivery,
} from "./ui/text.js";
export {
  phaseRows,
  WIKI_WORKFLOW_PHASES,
  WIKI_WORKFLOW_STAGES,
  type WikiPhase,
  type WikiRunView,
  type WikiWorkflowStage,
} from "./ui/stages.js";
export {
  phaseIdForKind,
  phaseMetaForKind,
  phaseRefForKind,
  phaseTitleForKind,
  type WikiWorkflowPhase,
  type WikiWorkflowPhaseId,
} from "./workflow-phases.js";
export {
  retryImpact,
  phaseRetryImpact,
  describeNodes,
  type WikiRetryImpact,
} from "./ui/impact.js";
export {
  WikiUiModel,
  type WikiNavigatorController,
  type WikiNavigatorWorkspace,
} from "./ui/model.js";
export {
  NavigatorState,
  keyToNavigatorIntent,
  type NavigatorView,
  type DashboardPane,
  type NavigatorConfirmation,
  type NavigatorConfirmationKind,
  type WikiNavigatorAction,
} from "./ui/state.js";
export {
  layoutForWidth,
  renderDashboard,
} from "./ui/render/dashboard.js";
export {
  renderRunsList,
  renderRunsEmpty,
  buildRunSelectItems,
} from "./ui/render/runs.js";
export {
  renderAgentView,
  attemptNumbers,
} from "./ui/render/agent.js";
export {
  PLAIN_THEME,
  STATUS_ICON,
  STATUS_COLOR,
  runTitle,
  asText,
  type WikiUiTheme,
} from "./ui/format.js";
export {
  uiStrings,
  type WikiUiLanguage,
  type WikiUiStrings,
} from "./ui/strings.js";
export {
  cancelConfirm,
  deleteConfirm,
  retryAgentConfirm,
  retryPhaseConfirm,
  type ConfirmPrompt,
} from "./ui/confirm.js";

export type {
  WikiAgentExecutionRequest,
  WikiAgentExecutionResult,
  WikiAgentExecutor,
  WikiCrossLink,
  WikiDomain,
  WikiLocalReviewDefect,
  WikiLocalReviewDefectKind,
  WikiNode,
  WikiNodeActivity,
  WikiNodeActivityState,
  WikiNodeError,
  WikiNodeErrorCode,
  WikiNodeKind,
  WikiNodeMetrics,
  WikiNodeStatus,
  WikiResearchReceipt,
  WikiResearchScope,
  WikiReviewDefect,
  WikiReviewDefectKind,
  WikiReviewResult,
  WikiRunEvent,
  WikiRunEventKind,
  WikiRunRequest,
  WikiRunSession,
  WikiRunSnapshot,
  WikiRunSummary,
  WikiRunStatus,
  WikiSharedTerm,
  WikiSpec,
  WikiSpecPage,
  WikiStructuralReviewDefect,
  WikiStructuralReviewDefectKind,
  WikiSynthesisExpandResult,
  WikiSynthesisFinalizeResult,
  WikiSynthesisResult,
  WikiWorkflowDependencies,
  WikiWorkflowListener,
} from "./workflow-types.js";
