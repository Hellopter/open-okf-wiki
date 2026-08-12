import { WIKI_WORKFLOW_PHASES, phaseIdForKind } from "./workflow-phases.js";
import type {
  WikiNode,
  WikiNodeStatus,
  WikiRunAgentView,
  WikiRunAllowedActions,
  WikiRunPhaseView,
  WikiRunSnapshot,
  WikiRunView,
} from "./workflow-types.js";

export interface ProjectWikiRunViewOptions {
  /** Identifies the run currently owned by the application, if any. */
  activeRunId?: string;
  /** Nodes with a live executor/controller; durable `running` alone is not proof of liveness. */
  liveNodeIds?: ReadonlySet<string> | readonly string[];
}

/** Project durable or live run state onto the only shape UI callers need. */
export function projectWikiRunView(
  snapshot: WikiRunSnapshot,
  options: ProjectWikiRunViewOptions = {},
): WikiRunView {
  const liveNodeIds = options.liveNodeIds instanceof Set
    ? options.liveNodeIds
    : new Set(options.liveNodeIds ?? []);
  const phases = WIKI_WORKFLOW_PHASES.map((phase): WikiRunPhaseView => {
    const nodes = snapshot.nodes.filter((node) => (node.phaseId ?? phaseIdForKind(node.kind)) === phase.id);
    return {
      id: phase.id,
      title: phase.title,
      status: phaseStatus(nodes),
      agents: nodes.map((node) => projectAgent(node, liveNodeIds.has(node.id))),
    };
  });
  const counts = (status: WikiNodeStatus): number => snapshot.nodes.filter((node) => node.status === status).length;

  return {
    id: snapshot.id,
    cwd: snapshot.cwd,
    requestedMode: snapshot.requestedMode,
    effectiveMode: snapshot.effectiveMode,
    language: snapshot.language,
    focus: snapshot.focus,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.completedAt,
    blockedReason: snapshot.blockedReason,
    blockedDetails: snapshot.blockedDetails ? structuredClone(snapshot.blockedDetails) : undefined,
    parentRunId: snapshot.parentRunId,
    phases,
    progress: {
      total: snapshot.nodes.length,
      queued: counts("queued"),
      running: counts("running"),
      succeeded: counts("succeeded"),
      failed: counts("failed") + counts("blocked"),
    },
    allowedActions: allowedWikiRunActions(snapshot, options.activeRunId),
  };
}

function projectAgent(node: WikiNode, live: boolean): WikiRunAgentView {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    attempt: node.attempt,
    activity: structuredClone(node.activity),
    metrics: structuredClone(node.metrics),
    error: node.error ? structuredClone(node.error) : undefined,
    handoff: node.handoff ? structuredClone(node.handoff) : undefined,
    retainedOutput: node.output,
    retainedHistory: node.history ? structuredClone(node.history) : undefined,
    startedAt: node.startedAt,
    finishedAt: node.finishedAt,
    live,
  };
}

function phaseStatus(nodes: readonly WikiNode[]): WikiRunPhaseView["status"] {
  if (nodes.length === 0) return "not_started";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "queued")) return "queued";
  if (nodes.some((node) => node.status === "invalidated")) return "invalidated";
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled";
  return "succeeded";
}

/** Single action policy used by the application for enforcement and by views for affordances. */
export function allowedWikiRunActions(
  snapshot: Pick<WikiRunSnapshot, "id" | "status">,
  activeRunId?: string,
): WikiRunAllowedActions {
  const { status } = snapshot;
  const active = activeRunId === snapshot.id;
  const workspaceIdle = activeRunId === undefined;
  const running = status === "running";
  const paused = status === "paused";
  const terminal = status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
  return {
    pause: active && running,
    resume: paused && (active || workspaceIdle),
    stop: active && (running || paused),
    cancel: active && (running || paused),
    retry: (active && paused) || terminal,
    delete: !active && terminal,
  };
}
