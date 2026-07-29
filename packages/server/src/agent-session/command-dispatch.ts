/**
 * Operator Session command dispatch: prompt / steer / abort / compact / set_model.
 * Plan/publication HITL is ResolveGate on WikiRuns (Run API), not a Session command.
 * Leading-slash prompts expand through the operator command registry before
 * reaching AgentSession.prompt (same single write path, ADR 0032).
 */

import {
  expandOperatorCommand,
  redactErrorMessage,
  resolveWorkspacePiModel,
} from "@okf-wiki/agent";
import type { AgentCommand, AgentCommandResponse, WorkspaceConfig } from "@okf-wiki/contract";
import { ensureRegistered, type RegisteredAgentSession } from "./live-session-registry.ts";
import { defaultTitle } from "./session-lifecycle.ts";

function titleFromPrompt(text: string, max = 60): string | undefined {
  const firstLine = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function providerFailure(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const row = message as { role?: string; stopReason?: string; errorMessage?: string };
    if (row.role !== "assistant") continue;
    if (row.stopReason === "error" || row.stopReason === "aborted" || row.errorMessage?.trim()) {
      const raw = row.errorMessage?.trim() || `assistant stopReason=${row.stopReason ?? "error"}`;
      return redactErrorMessage(raw);
    }
    return null;
  }
  return null;
}

async function prompt(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  text: string,
  canProduce: boolean,
): Promise<AgentCommandResponse> {
  if (entry.busy) {
    return {
      ok: false,
      sessionId: entry.handle.sessionId,
      command: "prompt",
      status: "failed",
      message: "Operator Session already has an active turn",
    };
  }
  entry.busy = true;
  try {
    const expansion = expandOperatorCommand(text);
    if (expansion.kind === "unknown") {
      return {
        ok: false,
        sessionId: entry.handle.sessionId,
        command: "prompt",
        status: "failed",
        message: `unknown command: /${expansion.command}`,
      };
    }
    const effectiveText = expansion.kind === "expanded" ? expansion.prompt : text;
    if (entry.handle.session.sessionManager.getSessionName()?.trim() === defaultTitle(workspace)) {
      const title = titleFromPrompt(text);
      if (title) entry.handle.session.setSessionName(title);
    }
    entry.queueFixtureTurn?.(effectiveText, canProduce);
    await entry.handle.session.prompt(effectiveText);
    const failure = providerFailure(entry.handle.session.messages);
    return failure
      ? {
          ok: false,
          sessionId: entry.handle.sessionId,
          command: "prompt",
          status: "failed",
          message: `prompt failed: ${failure}`,
        }
      : {
          ok: true,
          sessionId: entry.handle.sessionId,
          command: "prompt",
          status: "accepted",
          message: "prompt completed",
        };
  } catch (error) {
    return {
      ok: false,
      sessionId: entry.handle.sessionId,
      command: "prompt",
      status: "failed",
      message: `prompt failed: ${redactErrorMessage(error)}`,
    };
  } finally {
    entry.busy = false;
  }
}

/** Delegate commands only to the real AgentSession. */
export async function dispatchAgentCommand(
  workspace: WorkspaceConfig,
  sessionId: string,
  command: AgentCommand,
): Promise<AgentCommandResponse> {
  const entry = await ensureRegistered(workspace, sessionId);

  if (command.type === "prompt") {
    return prompt(entry, workspace, command.text, workspace.sources.length > 0);
  }
  if (command.type === "steer") {
    try {
      await entry.handle.session.steer(command.text);
      return { ok: true, sessionId, command: "steer", status: "accepted" };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command: "steer",
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  }
  if (command.type === "abort") {
    await entry.handle.session.abort().catch(() => undefined);
    return { ok: true, sessionId, command: "abort", status: "accepted" };
  }
  if (command.type === "set_model") {
    if (entry.busy) {
      return {
        ok: false,
        sessionId,
        command: "set_model",
        status: "failed",
        message: "Operator Session has an active turn; retry after it completes",
      };
    }
    try {
      const resolved = await resolveWorkspacePiModel({ profileId: command.profileId });
      await entry.handle.session.setModel(resolved.model);
      return {
        ok: true,
        sessionId,
        command: "set_model",
        status: "accepted",
        modelId: resolved.model.id,
      };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command: "set_model",
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  }
  await entry.handle.session.compact();
  return { ok: true, sessionId, command: "compact", status: "accepted" };
}
