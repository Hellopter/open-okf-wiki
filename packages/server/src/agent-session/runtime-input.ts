/**
 * Build Operator Session create/open input: model resolution, skill paths, wikiProduce.
 */

import {
  createOperatorFixtureModel,
  createOperatorSession,
  type RerunWikiNode,
  resolveModelSelection,
  resolveWorkspacePiModel,
  type StartWikiRun,
  shouldUsePiFixtureMode,
} from "@okf-wiki/agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { loadWorkspaceById, resolveWikiSkillPaths } from "@okf-wiki/core";
import { wikiRunsForWorkspace } from "../wiki-runs-registry.ts";

/** Portable result of runtimeInput (avoids leaking agent-internal declaration paths). */
export type RuntimeInputResult = {
  input: Parameters<typeof createOperatorSession>[0];
  queueFixtureTurn?: (text: string, canProduce: boolean) => void;
};

async function resolveRoleModel(
  workspace: WorkspaceConfig,
  role: "default" | "planner" | "worker" | "writer" | "reviewer",
  opts?: { seatIndex?: number },
) {
  const selected = resolveModelSelection({
    workspace,
    role,
    ...(opts?.seatIndex !== undefined ? { seatIndex: opts.seatIndex } : {}),
  });
  return resolveWorkspacePiModel({
    profileId: selected.profileId,
    modelId: selected.id,
  });
}

async function reloadWorkspace(workspace: WorkspaceConfig): Promise<WorkspaceConfig> {
  const current = await loadWorkspaceById(workspace.id, { rootPath: workspace.rootPath });
  if (!current) {
    throw new Error(`Workspace not found while starting Wiki Run: ${workspace.id}`);
  }
  return current;
}

function startWikiRunFor(workspace: WorkspaceConfig, sessionId: string): StartWikiRun {
  return async ({ commandId, sessionId: sid }) => {
    // Always reload from disk — session may have been opened before sources/settings were saved.
    const current = await reloadWorkspace(workspace);
    const runs = await wikiRunsForWorkspace(current);
    return runs.dispatch(
      { type: "start_run", commandId },
      {
        workspaceId: current.id,
        actor: { id: sid || sessionId, kind: "operator_session" },
        sessionId: sid || sessionId,
      },
    );
  };
}

/** Server-composed RerunNode dispatch for wiki_repair (ADR 0035). */
function rerunWikiNodeFor(workspace: WorkspaceConfig, sessionId: string): RerunWikiNode {
  return async ({ commandId, runId, nodeKey, generation, feedback, sessionId: sid }) => {
    const current = await reloadWorkspace(workspace);
    const runs = await wikiRunsForWorkspace(current);
    return runs.dispatch(
      {
        type: "rerun_node",
        commandId,
        runId,
        nodeKey,
        generation,
        ...(feedback !== undefined ? { feedback } : {}),
      },
      {
        workspaceId: current.id,
        actor: { id: sid || sessionId, kind: "operator_session" },
        sessionId: sid || sessionId,
      },
    );
  };
}

/** Resolve current generation for the default repair target (write.root). */
async function resolveRepairTargetFor(
  workspace: WorkspaceConfig,
  input: { runId: string },
): Promise<{ nodeKey: string; generation: number } | null> {
  const current = await reloadWorkspace(workspace);
  const runs = await wikiRunsForWorkspace(current);
  try {
    const { snapshot } = await runs.read({ runId: input.runId });
    const write = snapshot.nodes.find((node) => node.key === "write.root");
    if (write) return { nodeKey: write.key, generation: write.generation };
    // Fall back to any non-terminal node the operator can still rerun.
    const candidate = snapshot.nodes.find(
      (node) =>
        node.kind !== "freeze" &&
        !["cancelled", "blocked"].includes(node.state) &&
        node.key !== "gate.plan" &&
        node.key !== "gate.fix" &&
        node.key !== "gate.publication",
    );
    if (!candidate) return null;
    return { nodeKey: candidate.key, generation: candidate.generation };
  } catch {
    return null;
  }
}

/** Shared create/open runtime payload (model, skills, wikiProduce StartRun port). */
export async function runtimeInput(
  workspace: WorkspaceConfig,
  sessionId?: string,
): Promise<RuntimeInputResult> {
  const fixture = shouldUsePiFixtureMode({});
  const fixtureModel = fixture ? await createOperatorFixtureModel() : undefined;
  const operatorModel = fixtureModel ? undefined : await resolveRoleModel(workspace, "default");
  const skillPaths = await resolveWikiSkillPaths({
    workspaceRoot: workspace.rootPath,
    skillPath: workspace.skillPath,
  });
  const resolvedSessionId = sessionId ?? "pending";
  return {
    input: {
      workspace,
      ...(sessionId ? { sessionId } : {}),
      ...(fixtureModel
        ? { model: fixtureModel.model, modelRuntime: fixtureModel.modelRuntime }
        : operatorModel
          ? { model: operatorModel.model, modelRuntime: operatorModel.modelRuntime }
          : {}),
      additionalSkillPaths: skillPaths,
      contextTargetTokens: workspace.limits?.contextTargetTokens,
      maxContextTokens: operatorModel?.runtime.maxContextTokens,
      wikiProduce: {
        startWikiRun: startWikiRunFor(workspace, resolvedSessionId),
        rerunWikiNode: rerunWikiNodeFor(workspace, resolvedSessionId),
        resolveRepairTarget: (input) => resolveRepairTargetFor(workspace, input),
        resolveWorkspace: () => reloadWorkspace(workspace),
      },
    },
    queueFixtureTurn: fixtureModel
      ? (text: string, canProduce: boolean) => {
          if (canProduce) fixtureModel.queueWikiProduceTurn(text);
          else fixtureModel.queueAssistantTurn();
        }
      : undefined,
  };
}
