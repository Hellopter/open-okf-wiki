import type { WikiRunAgentView, WikiRunPhaseView, WikiRunView } from "../workflow-types.js";
export type { WikiRunView } from "../workflow-types.js";
import {
  WIKI_WORKFLOW_PHASES,
  WIKI_WORKFLOW_STAGES,
  type WikiWorkflowStage,
} from "../workflow-phases.js";

export type { WikiWorkflowStage };
export { WIKI_WORKFLOW_PHASES, WIKI_WORKFLOW_STAGES };

export interface WikiPhase {
  id: string;
  title: string;
  nodeIds: string[];
  conditional: boolean;
  waitingMessage: string;
  status: WikiRunPhaseView["status"];
  agents: readonly WikiRunAgentView[];
}

/** Fill the declared stage map from the application read model. */
export function phaseRows(run: WikiRunView): WikiPhase[] {
  return WIKI_WORKFLOW_STAGES.map((stage) => {
    const projected = run.phases.find((phase) => phase.id === stage.id);
    const agents = projected?.agents ?? [];
    return { ...stage, nodeIds: agents.map((agent) => agent.id), status: projected?.status ?? "not_started", agents };
  });
}

export function nodesForPhase(_run: WikiRunView, phase: WikiPhase): readonly WikiRunAgentView[] {
  return phase.agents;
}
