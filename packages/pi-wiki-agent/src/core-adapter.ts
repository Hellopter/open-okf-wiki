/**
 * Host-independent contract for the deterministic Wiki core.
 *
 * Pi owns interaction and agent orchestration. The core owns all persistent
 * Wiki state, snapshot verification, checkpoints, and candidate validation.
 */

export type WikiLanguage = "en" | "zh";
export type WikiRunMode = "auto" | "plan" | "write" | "restart" | "retry-plan" | "retry-write";

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

export interface WikiDomainRunSummary {
  runId: string;
  workdir?: string;
  source?: string;
  status?: string;
  error?: string;
}

export interface WikiWorkspaceStatus {
  root: string;
  name?: string;
  wikiLanguage?: WikiLanguage;
  initialized: boolean;
  activeRunId?: string;
  sources: WikiSource[];
  summary?: string;
  /** Present on full getWorkspaceStatus responses from the host API. */
  runtime?: string;
  current?: unknown;
  active?: WikiDomainRunSummary | null;
  runs?: WikiDomainRunSummary[];
}

export interface WikiRunPaths {
  root: string;
  runId: string;
  workdir: string;
  inputsDir: string;
  sourcesDir: string;
  methodDir: string;
  analysisDir: string;
  candidateDir: string;
}

export interface PrepareRunResult {
  status: "ok" | "failed";
  runId: string;
  workdir: string;
  workspaceRoot: string;
  mode: WikiRunMode;
  startAt: string;
  inputCheckpointDigest?: string | null;
  summary?: string;
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
  prepareRun(root: string, options: { mode: WikiRunMode; focus?: string }): Promise<PrepareRunResult>;
  mergeSurveyReceipts(root: string, options: { pass: number; labelsPath?: string; runId: string }): Promise<unknown>;
  publishCheckpoint(root: string, options: { phase: string; artifactsJsonPath: string; runId: string }): Promise<unknown>;
  openPlanGate(root: string, options: { runId: string }): Promise<unknown>;
  checkPlanGate(root: string, options: { runId: string }): Promise<unknown>;
  validateCandidate(root: string, options: { runId: string }): Promise<unknown>;
  getRunPaths(root: string, options?: { runId?: string }): Promise<WikiRunPaths | undefined>;
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
  "mergeSurveyReceipts",
  "publishCheckpoint",
  "openPlanGate",
  "checkPlanGate",
  "validateCandidate",
  "getRunPaths",
] as const;

type RequiredMethod = (typeof REQUIRED_METHODS)[number];

/**
 * Reject incomplete core exports at extension load rather than mid-run.
 *
 * Host-api methods may be synchronous. Wrap every required method so callers
 * can safely `await` / `.then` without crashing when the kit returns plain values.
 */
export function createCoreAdapter(module: Partial<CoreModule>): CoreAdapter {
  const missing = REQUIRED_METHODS.filter((key) => typeof module[key] !== "function");
  if (missing.length > 0) {
    throw new Error(`@okf-wiki/wiki-agent-kit is missing Pi core exports: ${missing.join(", ")}`);
  }

  const adapter = {} as CoreAdapter;
  for (const key of REQUIRED_METHODS) {
    const method = module[key] as (...args: never[]) => unknown;
    // Always return a Promise so sync host-api results and throws are await-safe.
    (adapter as Record<RequiredMethod, (...args: never[]) => Promise<unknown>>)[key] = async (
      ...args: never[]
    ) => method(...args);
  }
  return adapter;
}
