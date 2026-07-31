/**
 * Derive ephemeral Operator Session context-fill for SSE (UI only).
 * Not durable control truth — last-assistant totalTokens + known budget.
 */

import { resolveContextBudget } from "@okf-wiki/agent";
import {
  buildSessionUsage,
  extractContextTokensFromPiHistory,
  extractContextTokensFromPiMessage,
  type SessionUsage,
  type WorkspaceConfig,
} from "@okf-wiki/contract";

export type ContextBudget = {
  contextWindow?: number;
  contextTarget?: number;
};

/** Budget slice from a live handle or workspace defaults. */
export function contextBudgetFields(input: {
  contextBudget?: ContextBudget | null;
  workspace?: WorkspaceConfig | null;
}): { contextWindow?: number; contextTarget?: number } {
  if (input.contextBudget) {
    return {
      contextWindow: input.contextBudget.contextWindow,
      contextTarget: input.contextBudget.contextTarget,
    };
  }
  const budget = resolveContextBudget({
    contextTargetTokens: input.workspace?.limits?.contextTargetTokens,
  });
  return {
    contextWindow: budget.contextWindow,
    contextTarget: budget.contextTarget,
  };
}

/**
 * Compose sessionUsage from tokens + budget.
 * Without contextTokens, returns undefined so empty sessions do not paint a chip.
 */
export function composeSessionUsage(input: {
  contextTokens?: number;
  contextBudget?: ContextBudget | null;
  workspace?: WorkspaceConfig | null;
}): SessionUsage | undefined {
  if (
    typeof input.contextTokens !== "number" ||
    !Number.isFinite(input.contextTokens) ||
    input.contextTokens < 0
  ) {
    return undefined;
  }
  const budget = contextBudgetFields(input);
  return buildSessionUsage({
    contextTokens: input.contextTokens,
    contextWindow: budget.contextWindow,
    contextTarget: budget.contextTarget,
  });
}

/** From redacted Pi history rows + budget. */
export function sessionUsageFromPiRows(
  piRows: readonly unknown[],
  opts: { contextBudget?: ContextBudget | null; workspace?: WorkspaceConfig | null } = {},
): SessionUsage | undefined {
  return composeSessionUsage({
    contextTokens: extractContextTokensFromPiHistory(piRows),
    contextBudget: opts.contextBudget,
    workspace: opts.workspace,
  });
}

/**
 * If a Pi event is assistant message_end with usage, return updated sessionUsage.
 * Otherwise undefined (no change).
 */
export function sessionUsageFromPiEvent(
  event: unknown,
  prior: SessionUsage | undefined,
  opts: { contextBudget?: ContextBudget | null; workspace?: WorkspaceConfig | null } = {},
): SessionUsage | undefined {
  if (!event || typeof event !== "object") return undefined;
  const body = event as Record<string, unknown>;
  if (body.type !== "message_end") return undefined;
  const message = body.message;
  const tokens = extractContextTokensFromPiMessage(message);
  if (tokens === undefined) return undefined;
  const next = composeSessionUsage({
    contextTokens: tokens,
    contextBudget: opts.contextBudget,
    workspace: opts.workspace,
  });
  if (!next) return undefined;
  // Avoid re-emitting identical payloads on every frame.
  if (
    prior &&
    prior.contextTokens === next.contextTokens &&
    prior.contextWindow === next.contextWindow &&
    prior.contextTarget === next.contextTarget
  ) {
    return undefined;
  }
  return next;
}
