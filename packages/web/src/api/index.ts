/**
 * HTTP transport for the operator Web UI.
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 *
 * Barrel re-exports keep `from "../api"` / `from "../../api"` working after the split.
 */

export {
  ApiError,
  getApiBase,
  messageFromErrorBody,
  request,
  withRootPathQuery,
} from "./client";

export {
  type AppSettingsPublic,
  createModelProfile,
  createProvider,
  type DoctorResponse,
  deleteModelProfile,
  deleteProvider,
  getAppSettings,
  getDoctor,
  getHealth,
  getProvider,
  type HealthResponse,
  type ModelProfilePublic,
  type ModelProfileWriteInput,
  type ProviderApiShape,
  type ProviderEntryPublic,
  type ProviderEntryWriteInput,
  type ProviderPublic,
  type ProviderTestResult,
  patchAppSettings,
  setDefaultModelProfile,
  testProvider,
  updateModelProfile,
  updateProvider,
} from "./provider";

export {
  type AddSourceInput,
  addSource,
  type CloneSourceInput,
  cloneSource,
  type CreateWorkspaceInput,
  createWorkspace,
  createWorkspaceSkillFork,
  deleteSource,
  deleteWorkspace,
  type GitProbe,
  getWorkspace,
  getWorkspaceSkill,
  listWorkspaces,
  listWorkspaceSkillFiles,
  type PatchWorkspaceInput,
  patchWorkspace,
  probeSources,
  type SkillFileContent,
  type SkillFileEntry,
  type SkillInfo,
  type SourceOrigin,
  type SourceProbeResult,
  readWorkspaceSkillFile,
  resetWorkspaceSkill,
  type UpdateSourceInput,
  updateSource,
  type WikiLanguage,
  type WorkspaceConfig,
  type WorkspaceSource,
  type WorkspaceSummary,
  writeWorkspaceSkillFile,
} from "./workspaces";

export {
  dispatchWikiRunCommand,
  getWikiRun,
  getWikiRunAttemptTranscript,
  listRuns,
  type WikiRunAttemptTranscript,
  type WikiRunListItem,
  type WikiRunState,
  wikiRunAttemptTranscriptEventsUrl,
  wikiRunEventsUrl,
} from "./wiki-runs";

export {
  getWikiGraph,
  getWikiPage,
  listWikiPages,
  type WikiGraphNode,
  type WikiGraphResponse,
  type WikiNavNode,
  type WikiPageListResponse,
  type WikiPageResponse,
  type WikiPageSummary,
} from "./wiki";

export {
  type AgentCommand,
  type AgentCommandResponse,
  agentSessionCommand,
  agentSessionEventsUrl,
  type CreatePiAgentSessionBody,
  type CreatePiAgentSessionResponse,
  createAgentSession,
  deleteAgentSession,
  listAgentSessions,
  listOperatorCommands,
  type OperatorCommandInfo,
  type PiSessionSummary,
} from "./agent-sessions";
