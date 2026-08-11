import type { WikiNode, WikiRunSnapshot, WikiRunSummary } from "../workflow-types.js";
import { phaseRows, type WikiPhase } from "./stages.js";

/** Engine adapter. UI owns no workflow state and never edits the workspace. */
export interface WikiNavigatorController {
  listRuns(): WikiRunSummary[];
  getRun(runId?: string): WikiRunSnapshot | undefined;
  loadRun(runId: string): Promise<WikiRunSnapshot | undefined>;
  getActiveRunId(): string | undefined;
  /** True when the active engine still has a live executor for this node. */
  isNodeLive?(nodeId: string): boolean;
  getWorkspace?(): WikiNavigatorWorkspace | undefined;
  subscribe(listener: () => void): () => void;
  retryNode(runId: string, nodeId: string): Promise<WikiRunSnapshot | undefined> | WikiRunSnapshot | undefined;
  retryPhase(runId: string, phaseId: string): Promise<WikiRunSnapshot | undefined> | WikiRunSnapshot | undefined;
  deleteRun(runId: string): Promise<void> | void;
  pause(): Promise<void> | void;
  resume(runId?: string): Promise<void> | void;
  /** Hard-stop-resume: abort agents and requeue; run stays paused/resumable. */
  stop(): Promise<void> | void;
  cancel(): Promise<void> | void;
}

/** Static workspace metadata for idle console context. */
export interface WikiNavigatorWorkspace {
  root: string;
  language: "zh" | "en";
  sources: Array<{ path: string }>;
}

/**
 * Read-side model over the controller. Caches list/snapshot lookups for one
 * render frame so multi-pane dashboards do not re-walk history repeatedly.
 */
export class WikiUiModel {
  private frameDepth = 0;
  private frameRuns: WikiRunSummary[] | undefined;
  private readonly frameSnapshots = new Map<string, WikiRunSnapshot | undefined>();

  constructor(private readonly controller: WikiNavigatorController) {}

  withRenderFrame<T>(render: () => T): T {
    const outermost = this.frameDepth === 0;
    this.frameDepth++;
    try {
      return render();
    } finally {
      this.frameDepth--;
      if (outermost) {
        this.frameRuns = undefined;
        this.frameSnapshots.clear();
      }
    }
  }

  listRuns(): WikiRunSummary[] {
    if (this.frameDepth === 0) return this.controller.listRuns();
    if (!this.frameRuns) this.frameRuns = this.controller.listRuns();
    return this.frameRuns;
  }

  getRun(runId?: string): WikiRunSnapshot | undefined {
    const id = runId ?? this.controller.getActiveRunId();
    if (!id) return this.controller.getRun();
    if (this.frameDepth > 0 && this.frameSnapshots.has(id)) return this.frameSnapshots.get(id);
    const snapshot = this.controller.getRun(id);
    if (this.frameDepth > 0) this.frameSnapshots.set(id, snapshot);
    return snapshot;
  }

  getActiveRunId(): string | undefined {
    return this.controller.getActiveRunId();
  }

  /** Live executor only — historical queued/running without a controller is not "in flight". */
  isNodeLive(nodeId: string | undefined): boolean {
    if (!nodeId) return false;
    return this.controller.isNodeLive?.(nodeId) === true;
  }

  getWorkspace(): WikiNavigatorWorkspace | undefined {
    return this.controller.getWorkspace?.();
  }

  phases(runId?: string): WikiPhase[] {
    const run = this.getRun(runId);
    return run ? phaseRows(run) : [];
  }

  agents(runId: string | undefined, stageId: string | undefined): WikiNode[] {
    if (!runId || !stageId) return [];
    const run = this.getRun(runId);
    if (!run) return [];
    const phase = phaseRows(run).find((item) => item.id === stageId);
    if (!phase) return [];
    return phase.nodeIds
      .map((id) => run.nodes.find((node) => node.id === id))
      .filter((node): node is WikiNode => Boolean(node));
  }

  node(runId: string | undefined, nodeId: string | undefined): WikiNode | undefined {
    if (!runId || !nodeId) return undefined;
    return this.getRun(runId)?.nodes.find((node) => node.id === nodeId);
  }

  subscribe(listener: () => void): () => void {
    return this.controller.subscribe(listener);
  }

  raw(): WikiNavigatorController {
    return this.controller;
  }
}
