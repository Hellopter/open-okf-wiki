import path from "node:path";
import {
  type WorkspaceConfig,
  WorkspaceLimitsSchema,
  type WorkspacePatch,
} from "@okf-wiki/contract";
import { WorkspaceIntakeError } from "./workspace-errors.js";

export type ResolveModelSelection = (
  profileId: string,
) => Promise<{ id: string; profileId?: string }>;

export type WorkspacePatchDeps = {
  resolveModelSelection: ResolveModelSelection;
};

/**
 * Apply a validated {@link WorkspacePatch} onto a workspace config.
 * Resolves model selection via deps; absolute-resolves publicationPath / skillPath.
 * Does not persist — caller runs {@link saveWorkspace}.
 */
export async function applyWorkspacePatch(
  workspace: WorkspaceConfig,
  patch: WorkspacePatch,
  deps: WorkspacePatchDeps,
): Promise<WorkspaceConfig> {
  const next: WorkspaceConfig = { ...workspace };

  if (patch.name !== undefined) {
    next.name = patch.name;
  }

  if (patch.modelProfileId !== undefined || patch.model !== undefined) {
    const profileId = patch.modelProfileId ?? patch.model?.profileId;
    if (!profileId) {
      throw new WorkspaceIntakeError(
        "invalid_name",
        "modelProfileId is required (catalog profile selection)",
      );
    }
    const model = await deps.resolveModelSelection(profileId);
    next.model = {
      id: model.id,
      ...(model.profileId ? { profileId: model.profileId } : {}),
    };
  }

  if (patch.publicationPath !== undefined) {
    next.publicationPath = path.resolve(patch.publicationPath);
  }

  if (patch.limits !== undefined) {
    // Deep-merge so a partial PATCH (e.g. only requestTimeoutSeconds) does not
    // wipe retry / contextTargetTokens. Re-parse for defaults + validation.
    const prev = workspace.limits;
    const incoming = patch.limits;
    next.limits = WorkspaceLimitsSchema.parse({
      ...prev,
      ...incoming,
      retry: {
        ...prev.retry,
        ...(incoming.retry ?? {}),
        provider: {
          ...prev.retry?.provider,
          ...(incoming.retry?.provider ?? {}),
        },
      },
    });
  }

  if (patch.skillPath !== undefined) {
    if (patch.skillPath === null) {
      delete next.skillPath;
    } else {
      next.skillPath = path.resolve(patch.skillPath);
    }
  }

  if (patch.planConfirm !== undefined) {
    next.planConfirm = patch.planConfirm;
  }

  if (patch.wikiLanguage !== undefined) {
    next.wikiLanguage = patch.wikiLanguage;
  }

  if (patch.roleModels !== undefined) {
    next.roleModels = patch.roleModels;
  }

  if (patch.orchestration !== undefined) {
    next.orchestration = patch.orchestration;
  }

  if (patch.operatorTools !== undefined) {
    next.operatorTools = patch.operatorTools;
  }

  // rootPath and id are immutable via PATCH
  return next;
}
