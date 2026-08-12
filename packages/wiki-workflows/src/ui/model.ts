import type { WikiRunIntent } from "../application.js";
import type { WikiRunAgentView, WikiRunSummary, WikiRunView } from "../workflow-types.js";
import { phaseRows, type WikiPhase } from "./stages.js";

/** Engine adapter. UI owns no workflow state and never edits the workspace. */
export interface WikiNavigatorController {
  listRuns(): WikiRunSummary[];
  observe(runId?: string): WikiRunView | undefined;
  load(runId: string): Promise<WikiRunView | undefined>;
  activeRunId(): string | undefined;
  dispatch(intent: WikiRunIntent): Promise<WikiRunView | undefined> | WikiRunView | undefined;
  getWorkspace?(): WikiNavigatorWorkspace | undefined;
  subscribe(listener: () => void): () => void;
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
  private readonly frameSnapshots = new Map<string, WikiRunView | undefined>();

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

  getRun(runId?: string): WikiRunView | undefined {
    const id = runId ?? this.controller.activeRunId();
    if (!id) return this.controller.observe();
    if (this.frameDepth > 0 && this.frameSnapshots.has(id)) return this.frameSnapshots.get(id);
    const snapshot = this.controller.observe(id);
    if (this.frameDepth > 0) this.frameSnapshots.set(id, snapshot);
    return snapshot;
  }

  getActiveRunId(): string | undefined {
    return this.controller.activeRunId();
  }

  getWorkspace(): WikiNavigatorWorkspace | undefined {
    return this.controller.getWorkspace?.();
  }

  phases(runId?: string): WikiPhase[] {
    const run = this.getRun(runId);
    return run ? phaseRows(run) : [];
  }

  agents(runId: string | undefined, stageId: string | undefined): readonly WikiRunAgentView[] {
    if (!runId || !stageId) return [];
    const run = this.getRun(runId);
    if (!run) return [];
    const phase = phaseRows(run).find((item) => item.id === stageId);
    if (!phase) return [];
    return phase.agents;
  }

  node(runId: string | undefined, nodeId: string | undefined): WikiRunAgentView | undefined {
    if (!runId || !nodeId) return undefined;
    return this.getRun(runId)?.phases.flatMap((phase) => phase.agents).find((node) => node.id === nodeId);
  }

  load(runId: string): Promise<WikiRunView | undefined> { return this.controller.load(runId); }

  dispatch(intent: WikiRunIntent): Promise<WikiRunView | undefined> | WikiRunView | undefined {
    return this.controller.dispatch(intent);
  }

  subscribe(listener: () => void): () => void {
    return this.controller.subscribe(listener);
  }

}
