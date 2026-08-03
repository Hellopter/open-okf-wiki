/**
 * Resolve which Settings model profile a Wiki role should use.
 *
 * Workspace.model is the default. roleModels maps planner/worker/writer/reviewers
 * for hybrid economics. Callers may also pass an explicit profileId override
 * (e.g. operator picks a model when starting a Wiki Run).
 */

import type { ModelRef, WorkspaceConfig } from "@okf-wiki/contract/workspace";

/** Semantic roles that can select a model profile. */
export type WikiModelRole = "default" | "planner" | "worker" | "writer" | "reviewer";

export type ResolvedModelRef = {
  /** Served model id (denormalized). */
  id: string;
  profileId?: string;
  /** Which role mapping produced this ref. */
  role: WikiModelRole;
  /** True when an explicit operator model override won. */
  overridden: boolean;
};

/**
 * Pick the ModelRef for a role, falling back to workspace.model.
 * For reviewers, `seatIndex` rotates through `roleModels.reviewers[]`.
 */
export function modelRefForRole(
  workspace: WorkspaceConfig,
  role: WikiModelRole = "default",
  opts?: { seatIndex?: number },
): ModelRef {
  const roles = workspace.roleModels;
  if (role === "planner" && roles?.planner) {
    return roles.planner;
  }
  if (role === "worker" && roles?.worker) {
    return roles.worker;
  }
  if (role === "writer") {
    if (roles?.writer) return roles.writer;
    if (roles?.planner) return roles.planner;
  }
  if (role === "reviewer") {
    const list = roles?.reviewers ?? [];
    if (list.length > 0) {
      const seat = Math.max(0, opts?.seatIndex ?? 0);
      return list[seat % list.length]!;
    }
  }
  return workspace.model;
}

/**
 * Resolve model selection for a live call.
 * `overrideProfileId` wins when set (operator run-time catalog choice).
 * Denormalized id may be supplied only alongside a profile (from catalog resolve).
 */
export function resolveModelSelection(input: {
  workspace: WorkspaceConfig;
  role?: WikiModelRole;
  /** Council seat for reviewer role (maps to roleModels.reviewers[i]). */
  seatIndex?: number;
  /** Explicit catalog profile id selected for the Operator Session. */
  overrideProfileId?: string;
  /** Denormalized served model id from the selected profile (not free-text alone). */
  overrideModelId?: string;
}): ResolvedModelRef {
  const role = input.role ?? "default";

  if (input.overrideProfileId?.trim()) {
    return {
      id: input.overrideModelId?.trim() || input.workspace.model.id,
      profileId: input.overrideProfileId.trim(),
      role,
      overridden: true,
    };
  }

  const ref = modelRefForRole(input.workspace, role, { seatIndex: input.seatIndex });
  return {
    id: ref.id,
    profileId: ref.profileId,
    role,
    overridden: false,
  };
}
