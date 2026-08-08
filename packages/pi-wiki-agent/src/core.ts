/**
 * Pi depends on the kit's public contract directly. These are intentionally
 * capability ports, not a second copy of the kit's data model.
 */
import type {
  WikiCore,
  WikiLanguage,
  WikiRunAccessCore,
  WikiRunLifecycleCore,
  WikiRunPaths,
  WikiRunState,
  WikiRuntimeDefinition,
  WikiSource,
  WikiWorkspaceCore,
  WikiWorkspaceStatus,
} from "@okf-wiki/wiki-agent-kit";

export type {
  WikiCore,
  WikiLanguage,
  WikiRunAccessCore,
  WikiRunLifecycleCore,
  WikiRunPaths,
  WikiRunState,
  WikiRuntimeDefinition,
  WikiSource,
  WikiWorkspaceCore,
  WikiWorkspaceStatus,
};

export type WorkspaceCore = WikiWorkspaceCore;
export type RunLifecycleCore = WikiRunLifecycleCore;
export type RunAccessCore = WikiRunAccessCore;
export type OrchestrationCore = WikiRunLifecycleCore & WikiRunAccessCore & Pick<WikiWorkspaceCore, "getWorkspaceStatus">;
export type ToolCore = WikiWorkspaceCore & WikiRunAccessCore;
