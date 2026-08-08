export type WikiLanguage = "en" | "zh";
export type ApprovalMode = "propose" | "auto";
export type RunStatus =
  | "planning"
  | "proposed"
  | "writing"
  | "validating"
  | "quality_blocked"
  | "paused"
  | "stopped"
  | "failed"
  | "complete";
export type ResumeAt = "discover" | "plan" | "write";
export type QualityStatus = "pending" | "repairing" | "blocked" | "passed";

export interface WikiRuntimeDefinition {
  kind: "pi";
  extension: string;
  workflow: { id: string; digest: string };
}

export interface WikiSource {
  id: string;
  path: string;
  applyDefaultIgnores: boolean;
  ignore: string[];
  presets: string[];
  origin:
    | { type: "clone"; remoteUrl: string; ref?: string; clonedAt: string }
    | { type: "path"; linkedPath: string; linkType: "junction" | "dir" };
}

export interface WikiSourceSummary extends WikiSource {
  kind: "clone" | "linked";
  url?: string;
  root?: string;
  effectiveIgnores: string[];
}

export interface QualityReport {
  id: string;
  path: string;
  valid: boolean;
  verdict: "PASS" | "FAIL" | null;
  errors: string[];
}

export interface RunQuality {
  status: QualityStatus;
  recoveryCount: number;
  reports: QualityReport[];
  errors: string[];
  checkedAt?: string;
  resumedAt?: string;
}

export interface WikiRunState {
  version: 5;
  runId: string;
  status: RunStatus;
  resumeAt: ResumeAt;
  approval: ApprovalMode;
  planDigest: string | null;
  approvedAt: string | null;
  mainSessionPath: string | null;
  bundle: { digest: string; sealedAt: string } | null;
  quality: RunQuality;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WikiRunPaths {
  root: string;
  runId: string;
  runDir: string;
  inputsDir: string;
  sourcesDir: string;
  methodDir: string;
  analysisDir: string;
  statePath: string;
  planPath: string;
  discoveryDir: string;
  evidenceDir: string;
  coverageReviewPath: string;
  reviewPath: string;
  qualityReportsDir: string;
  qualityReportPaths: Record<string, string>;
  mainSessionDir: string;
  bundleDir: string;
}

export interface WikiWorkspaceStatus {
  root: string;
  initialized: true;
  name: string;
  wikiLanguage: WikiLanguage;
  approval: ApprovalMode;
  activeRunId?: string;
  sources: WikiSourceSummary[];
  runtime: "pi";
  active: (WikiRunPaths & { status: RunStatus }) | null;
  runs: Array<{ runId: string; createdAt: string; status: RunStatus; focus: string | null }>;
}

export interface WikiCoreDependencies {
  now?: () => Date;
  uuid?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  git?: (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface WikiCore {
  initializeWorkspace(root: string, options: {
    name?: string;
    wikiLanguage?: WikiLanguage;
    force?: boolean;
    runtime: WikiRuntimeDefinition;
    source?: { type: "path"; path: string; id?: string; ignore?: string[] } | { type: "clone"; url: string; id?: string; ref?: string; depth?: number };
  }): Promise<{ ok: true; created: boolean; workspace: WikiWorkspaceStatus; runtimeInstalled: boolean; source: WikiSourceSummary | null; hint: string | null }>;
  getWorkspaceStatus(root: string): Promise<WikiWorkspaceStatus>;
  addClonedSource(root: string, options: { url: string; id?: string; ref?: string; depth?: number }): Promise<WikiSourceSummary>;
  addLinkedSource(root: string, options: { path: string; id?: string; ignore?: string[] }): Promise<WikiSourceSummary>;
  removeSource(root: string, sourceId: string): Promise<{ removed: string }>;
  listSources(root: string): Promise<WikiSourceSummary[]>;
  prepareRun(root: string, options?: { focus?: string }): Promise<RunPreparation>;
  recordMainSession(root: string, options: { runId: string; mainSessionPath: string }): Promise<WikiRunState>;
  completeRunPlanning(root: string, options: { runId: string }): Promise<RunPlanningCompletion>;
  approveRun(root: string, options: { runId: string; planDigest?: string }): Promise<RunPlanningCompletion>;
  resumeRun(root: string, options: { runId: string }): Promise<RunResumption>;
  reportRunStatus(root: string, options: { runId: string; status: "paused" | "stopped" | "failed"; error?: string }): Promise<WikiRunState>;
  validateRunBundle(root: string, options: { runId: string }): Promise<RunValidationResult>;
  getRunPaths(root: string, options: { runId: string }): Promise<WikiRunPaths>;
  getRunState(root: string, options: { runId: string }): Promise<WikiRunState>;
  getRunQuality(root: string, options: { runId: string }): Promise<RunQuality>;
  claimRun(root: string, options: { runId: string; orchestrationId: string }): Promise<{ claimed: boolean; orchestrationId: string }>;
  releaseRun(root: string, options: { runId: string; orchestrationId: string }): Promise<{ released: boolean }>;
}

/** Narrow ports let each Pi subsystem depend only on the core behavior it owns. */
export type WikiWorkspaceCore = Pick<
  WikiCore,
  "initializeWorkspace" | "getWorkspaceStatus" | "addClonedSource" | "addLinkedSource" | "removeSource" | "listSources"
>;
export type WikiRunLifecycleCore = Pick<
  WikiCore,
  "prepareRun" | "recordMainSession" | "completeRunPlanning" | "approveRun" | "resumeRun" | "reportRunStatus" | "validateRunBundle" | "claimRun" | "releaseRun"
>;
export type WikiRunAccessCore = Pick<WikiCore, "getRunPaths" | "getRunState" | "getRunQuality">;

export interface RunPreparation extends WikiRunPaths {
  state: WikiRunState;
  resumeAt: ResumeAt;
  adaptiveDiscovery: { enabled: boolean; maxAgents: number };
}

export interface RunPlanningCompletion extends WikiRunPaths {
  state: WikiRunState;
  planDigest: string;
  requiresApproval: boolean;
  resumeAt: ResumeAt;
}

export interface RunResumption extends WikiRunPaths {
  state: WikiRunState;
  resumeAt: ResumeAt;
  adaptiveDiscovery: { enabled: boolean; maxAgents: number };
  qualityRecovery: boolean;
}

export interface RunValidationResult extends WikiRunPaths {
  ok: boolean;
  alreadySealed?: boolean;
  errors: string[];
  warnings: string[];
  state: WikiRunState;
  status: RunStatus;
}
