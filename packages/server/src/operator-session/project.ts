/**
 * Browser Session DTO projection and session chrome helpers.
 *
 * Pi holds the authoritative conversation record. The browser only receives
 * ADR 0039's Session DTO: user-visible prose, tool lifecycle, and bounded
 * wiki_produce receipts.
 */
import { createHash } from "node:crypto";
import { redactErrorMessage, redactSensitiveText, resolveSeatContextBudget } from "@okf-wiki/agent";
import {
  type AgentSessionContextBudget,
  type AgentSessionModel,
  type AgentSseStream,
  type SessionMessage,
  type SessionStreamState,
  type SessionUsage,
  buildSessionUsage,
  diffSessionStreamState,
} from "@okf-wiki/contract/session";
import type { AgentMessage, PiStreamState } from "@okf-wiki/contract/stream-server";
import { emit, type LiveSession } from "./registry.ts";

/** Remove all absolute filesystem paths, including paths outside common home dirs. */
export function redactSessionText(text: string): string {
  return redactSensitiveText(text).replace(
    /(^|[\s"'`=(])\/(?:[^\s"'`)]+)/g,
    (_match, prefix: string) => `${prefix}[redacted-path]`,
  );
}

/** Keep wire identifiers stable while preventing malformed provider ids from leaking paths. */
export function safeSessionId(value: string, kind: "message" | "tool"): string {
  if (/^[A-Za-z0-9_-]{1,200}$/.test(value)) return value;
  return `${kind}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

/**
 * Pi holds the authoritative conversation record. The browser only receives
 * ADR 0039's Session DTO: user-visible prose, tool lifecycle, and bounded
 * wiki_produce receipts. Thought, raw tools, system rows, and paths remain in
 * the server-side Pi state and JSONL history.
 */
export function projectOperatorMessage(message: AgentMessage): SessionMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const tools = message.tools?.map((tool) => ({
    id: safeSessionId(tool.id, "tool"),
    name: /^[a-z][a-z0-9_]{0,99}$/.test(tool.name) ? tool.name : "tool",
    status: tool.status,
    ...(tool.name === "wiki_produce" && tool.details
      ? {
          receipt: {
            status: tool.details.status,
            ...(tool.details.runId && /^[A-Za-z0-9_-]{1,200}$/.test(tool.details.runId)
              ? { runId: tool.details.runId }
              : {}),
            ...(tool.details.summary
              ? { summary: redactSessionText(tool.details.summary).slice(0, 4_000) }
              : {}),
          },
        }
      : {}),
  }));
  return {
    id: safeSessionId(message.id, "message"),
    role: message.role,
    content: redactSessionText(message.content),
    createdAt: message.createdAt,
    ...(tools?.length ? { tools } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.errorText
      ? { errorText: redactSessionText(redactErrorMessage(message.errorText)) }
      : {}),
  };
}

/** Optional session chrome projected onto the browser Session DTO. */
export type OperatorStreamChrome = {
  model?: AgentSessionModel;
  contextBudget?: AgentSessionContextBudget;
};

/** A dedicated, secret-free wire projection for the browser Session SSE. */
export function projectOperatorStreamState(
  state: PiStreamState,
  sessionUsage?: SessionUsage,
  chrome?: OperatorStreamChrome,
): SessionStreamState {
  const messages = state.messages.flatMap((message) => {
    const projected = projectOperatorMessage(message);
    return projected ? [projected] : [];
  });
  const streamingMessage = state.streamingMessage
    ? projectOperatorMessage(state.streamingMessage)
    : null;
  const lastAssistantId =
    [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null;
  return {
    messages,
    streamingMessage,
    lastAssistantId,
    turnActive: state.turnActive,
    agentStatus: state.agentStatus,
    errorText: state.errorText ? redactSessionText(redactErrorMessage(state.errorText)) : null,
    contextPhase: state.contextPhase,
    ...(sessionUsage ? { sessionUsage } : {}),
    ...(chrome?.model ? { model: chrome.model } : {}),
    ...(chrome?.contextBudget ? { contextBudget: chrome.contextBudget } : {}),
  };
}

/** Project live handle conversation + session chrome for SSE snapshot/stream. */
export function projectLiveView(live: LiveSession, state: PiStreamState = live.state): SessionStreamState {
  return projectOperatorStreamState(state, live.sessionUsage, {
    ...(live.model ? { model: live.model } : {}),
    ...(live.contextBudget ? { contextBudget: live.contextBudget } : {}),
  });
}

export function emitStatePatch(
  live: LiveSession,
  previous: SessionStreamState,
  next: SessionStreamState,
): void {
  emit(live, {
    source: "server",
    kind: "stream",
    sessionId: live.sessionId,
    timestamp: live.updatedAt,
    payload: diffSessionStreamState(previous, next),
  } satisfies AgentSseStream);
}

export function sessionModelFromParts(input: {
  profileId?: string;
  modelId: string;
  name?: string;
}): AgentSessionModel {
  return {
    profileId: input.profileId?.trim() || "default",
    modelId: input.modelId,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
  };
}

export function budgetFromSeat(input: {
  maxContextTokens?: number;
  modelContextWindow?: number;
  contextTargetTokens?: number;
}): AgentSessionContextBudget {
  const budget = resolveSeatContextBudget({
    maxContextTokens: input.maxContextTokens,
    modelContextWindow: input.modelContextWindow,
    contextTargetTokens: input.contextTargetTokens,
  });
  return {
    contextWindow: budget.contextWindow,
    contextTarget: budget.contextTarget,
    reserveTokens: budget.reserveTokens,
  };
}

export function usageWithBudget(
  budget: AgentSessionContextBudget | undefined,
  contextTokens?: number,
  prior?: SessionUsage,
): SessionUsage | undefined {
  return buildSessionUsage({
    contextTokens: contextTokens ?? prior?.contextTokens,
    contextWindow: budget?.contextWindow ?? prior?.contextWindow,
    contextTarget: budget?.contextTarget ?? prior?.contextTarget,
  });
}
