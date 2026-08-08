/** Public v4 core surface. */

export * from "./paths.mjs";
export * from "./ignores.mjs";
export {
  WORKSPACE_VERSION,
  APPROVAL_MODES,
  defaultWorkspace,
  loadWorkspaceConfig,
  saveWorkspace,
  ensureWorkspaceLayout,
  initWorkspace as initializeWorkspaceDocument,
  loadWorkspace as loadWorkspaceDocument,
  findSource,
  upsertSource,
} from "./workspace.mjs";
export {
  addCloneSource,
  addPathSource,
  linkPathSource,
  removeSource,
  listSources as listWorkspaceSources,
  resolveSourceAbs,
} from "./sources.mjs";
export * from "./install.mjs";
export * from "./inventory.mjs";
export { freezeRun, loadRunMeta, listRuns, verifyFrozenSnapshot } from "./freeze.mjs";
export * from "./active-run.mjs";
export {
  parseMarkdownFrontmatter,
  parseQualityReports,
  validatePlanningQuality,
  stampBundleMetadata,
  regenerateIndexes,
  validateBundle,
  sealBundle,
  bundleSealStatus,
} from "./validate.mjs";
export * from "./host-api.mjs";
