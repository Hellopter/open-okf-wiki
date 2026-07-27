/**
 * Build Operator Session create/open input: model resolution, skill paths, wikiProduce.
 */

import {
  createOperatorFixtureModel,
  createOperatorSession,
  resolveModelSelection,
  resolveWorkspacePiModel,
  shouldUsePiFixtureMode,
} from "@okf-wiki/agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { loadWorkspaceById, resolveWikiSkillPaths } from "@okf-wiki/core";
import { gateCoordinator } from "./wiki-produce-gate-coordinator.ts";

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

/** Shared create/open runtime payload (model, skills, wikiProduce gate). */
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
        gateCoordinator: gateCoordinator(workspace.id, sessionId ?? "pending"),
        resolveWorkspace: () => reloadWorkspace(workspace),
        fixture,
        resolveModel: fixture
          ? undefined
          : async (
              role: "planner" | "worker" | "writer" | "reviewer",
              currentWorkspace: WorkspaceConfig,
              opts?: { seatIndex?: number },
            ) => {
              const resolved = await resolveRoleModel(currentWorkspace, role, opts);
              return {
                model: resolved.model,
                modelRuntime: resolved.modelRuntime,
                maxContextTokens: resolved.runtime.maxContextTokens,
              };
            },
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
