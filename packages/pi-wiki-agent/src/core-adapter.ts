/**
 * Host-independent contract for the deterministic Wiki core.
 *
 * The core owns durable run state and validation. Pi owns the agent session and
 * Markdown work products. This boundary intentionally has no model-authored JSON
 * artifact APIs: handoffs live in the run's Markdown files.
 */

export type WikiLanguage = "en" | "zh";

export interface WikiRuntimeDefinition {
  kind: "pi";
  extension: "@okf-wiki/pi-wiki-agent";
  workflow: { id: string; digest: `sha256:${string}` };
}

export interface WikiSource {
  id: string;
  kind: "clone" | "linked";
  root?: string;
  url?: string;
  label?: string;
}

export interface WikiRunSummary {
  runId: string;
  status?: string;
  focus?: string;
  error?: string;
  updatedAt?: string;
}

export interface WikiWorkspaceStatus {
  root: string;
  name?: string;
  wikiLanguage?: WikiLanguage;
  initialized: boolean;
  activeRunId?: string;
  sources: WikiSource[];
  summary?: string;
  runtime?: string;
  current?: unknown;
  active?: WikiRunSummary | null;
  runs?: WikiRunSummary[];
}

/** Directories belonging to one v4 run. Alternative aliases are deliberately absent. */
export interface WikiRunPaths {
  root: string;
  runId: string;
  inputsDir: string;
  sourcesDir: string;
  analysisDir: string;
  bundleDir: string;
  sessionDir: string;
}

export interface WikiRunState {
  runId: string;
  status: "prepared" | "planning" | "proposed" | "approved" | "writing" | "validating" | "quality_blocked" | "completed" | "failed" | "paused" | "stopped" | string;
  approval?: "propose" | "auto";
  requiresApproval?: boolean;
  focus?: string;
  planDigest?: string;
  sessionPath?: string;
  error?: string;
  /** Transient recovery point returned by `resumeRun`; it is not necessarily persisted. */
  startAt?: string;
}

export interface PrepareRunResult {
  status: "ok" | "failed";
  runId: string;
  root: string;
  /** Core-selected recovery point for a previously non-terminal run. */
  startAt?: string;
  summary?: string;
}

export interface WikiPlanningResult {
  ok?: boolean;
  runId: string;
  status: "proposed" | "writing" | string;
  planDigest?: string;
  requiresApproval: boolean;
  state?: WikiRunState;
}

export interface WikiRunClaim {
  ok: boolean;
  claimed: boolean;
  claim?: { owner?: string; claimedAt?: string };
}

export interface CoreAdapter {
  initWorkspace(root: string, options: { name?: string; wikiLanguage?: WikiLanguage; force?: boolean; runtimeDefinition: WikiRuntimeDefinition }): Promise<WikiWorkspaceStatus>;
  ensureRuntime(root: string, options: { runtimeDefinition: WikiRuntimeDefinition }): Promise<unknown>;
  loadWorkspace(root: string): Promise<WikiWorkspaceStatus | undefined>;
  getWorkspaceStatus(root: string): Promise<WikiWorkspaceStatus>;
  addClonedSource(root: string, options: { url: string; id?: string; label?: string }): Promise<WikiSource>;
  addLinkedSource(root: string, options: { path: string; id?: string; label?: string; ignore?: string[] }): Promise<WikiSource>;
  removeSource(root: string, sourceId: string): Promise<void>;
  listSources(root: string): Promise<WikiSource[]>;
  prepareRun(root: string, options: { focus?: string }): Promise<PrepareRunResult>;
  completeRunPlanning(root: string, options: { runId: string; sessionPath?: string }): Promise<WikiPlanningResult>;
  approveRun(root: string, options: { runId: string; planDigest?: string }): Promise<WikiRunState>;
  resumeRun(root: string, options: { runId: string }): Promise<WikiRunState>;
  setRunStatus(root: string, options: { runId: string; status: string; sessionPath?: string; error?: string }): Promise<WikiRunState>;
  validateRunBundle(root: string, options: { runId: string }): Promise<WikiRunState>;
  getRunPaths(root: string, options?: { runId?: string }): Promise<WikiRunPaths | undefined>;
  getRunState(root: string, options: { runId: string }): Promise<WikiRunState | undefined>;
  claimRun(root: string, options: { runId: string; owner: string }): Promise<WikiRunClaim>;
  releaseRun(root: string, options: { runId: string; owner: string }): Promise<{ ok: boolean; released: boolean }>;
}

export type CoreModule = CoreAdapter;

const REQUIRED_METHODS = [
  "initWorkspace",
  "ensureRuntime",
  "loadWorkspace",
  "getWorkspaceStatus",
  "addClonedSource",
  "addLinkedSource",
  "removeSource",
  "listSources",
  "prepareRun",
  "completeRunPlanning",
  "approveRun",
  "resumeRun",
  "setRunStatus",
  "validateRunBundle",
  "getRunPaths",
  "getRunState",
  "claimRun",
  "releaseRun",
] as const;

type RequiredMethod = (typeof REQUIRED_METHODS)[number];

/** Reject an incomplete host API at extension load; normalize sync exports to Promises. */
export function createCoreAdapter(module: Partial<CoreModule>): CoreAdapter {
  const missing = REQUIRED_METHODS.filter((key) => typeof module[key] !== "function");
  if (missing.length > 0) {
    throw new Error(`@okf-wiki/wiki-agent-kit is missing Pi core exports: ${missing.join(", ")}`);
  }

  const adapter = {} as CoreAdapter;
  for (const key of REQUIRED_METHODS) {
    const method = module[key] as (...args: never[]) => unknown;
    (adapter as Record<RequiredMethod, (...args: never[]) => Promise<unknown>>)[key] = async (
      ...args: never[]
    ) => method(...args);
  }
  return adapter;
}
