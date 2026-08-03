/**
 * Operator Session command dispatch (prompt/steer/follow_up/control/model).
 */
import { randomUUID } from "node:crypto";
import {
  redactErrorMessage,
  resolveOperatorCommand,
  resolveWorkspacePiModel,
} from "@okf-wiki/agent";
import type { AgentCommand, AgentCommandResponse } from "@okf-wiki/contract/session";
import { deriveContextPhase, reducePiEvent } from "@okf-wiki/contract/stream-server";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import {
  budgetFromSeat,
  emitStatePatch,
  projectLiveView,
  sessionModelFromParts,
  usageWithBudget,
} from "./project.ts";
import {
  defaultSessionTitle,
  openLive,
  titleFromPrompt,
} from "./lifecycle.ts";
import { assertLiveAvailable, assertWorkspaceAvailable } from "./workspace-guard.ts";

function response(
  sessionId: string,
  command: AgentCommandResponse["command"],
  status: "accepted" | "failed",
  message?: string,
): AgentCommandResponse {
  return { ok: status === "accepted", sessionId, command, status, ...(message ? { message } : {}) };
}

export async function dispatchSessionCommand(
  workspace: WorkspaceConfig,
  sessionId: string,
  command: AgentCommand,
): Promise<AgentCommandResponse> {
  await assertWorkspaceAvailable(workspace);
  const live = await openLive(workspace, sessionId);
  await assertLiveAvailable(workspace, live);
  if (command.type === "abort") {
    void live.handle.session.abort().catch(() => undefined);
    live.busy = false;
    return response(sessionId, "abort", "accepted");
  }
  if (command.type === "clear_queue") {
    live.handle.session.clearQueue();
    return response(sessionId, "clear_queue", "accepted");
  }
  if (command.type === "abort_compaction") {
    live.handle.session.abortCompaction();
    return response(sessionId, "abort_compaction", "accepted");
  }
  if (command.type === "compact") {
    if (live.busy && command.mode !== "stop_and_compact") {
      return response(
        sessionId,
        "compact",
        "failed",
        "Wait for the current turn before compacting",
      );
    }
    if (command.mode === "stop_and_compact") {
      await live.handle.session.abort();
      await assertLiveAvailable(workspace, live);
    }
    void live.handle.session.compact().catch(() => undefined);
    return response(sessionId, "compact", "accepted");
  }
  if (command.type === "set_model") {
    if (live.busy) return response(sessionId, "set_model", "failed", "Wait for the current turn");
    const resolved = await resolveWorkspacePiModel({ profileId: command.profileId });
    await assertLiveAvailable(workspace, live);
    await live.handle.session.setModel(resolved.model);
    // Session-scoped only: do not mutate workspace.model or write provider defaults.
    // Capture prior chrome so the stream patch carries the new model without reconnect.
    const previousView = projectLiveView(live);
    const modelContextWindow =
      typeof resolved.model.contextWindow === "number" && resolved.model.contextWindow > 0
        ? resolved.model.contextWindow
        : undefined;
    live.model = sessionModelFromParts({
      profileId: resolved.runtime.profileId ?? command.profileId,
      modelId: resolved.servedModelId || resolved.model.id,
      name:
        (typeof resolved.model.name === "string" && resolved.model.name.trim()
          ? resolved.model.name
          : undefined) ?? resolved.runtime.profileName,
    });
    live.contextBudget = budgetFromSeat({
      maxContextTokens: resolved.runtime.maxContextTokens,
      modelContextWindow,
      contextTargetTokens: workspace.limits.contextTargetTokens,
    });
    live.sessionUsage = usageWithBudget(
      live.contextBudget,
      live.sessionUsage?.contextTokens,
      live.sessionUsage,
    );
    // Re-derive pressure against the new seat budget. Keep compacting while a
    // compaction is in flight so the meter does not flicker to a fill phase.
    const compacting =
      live.state.contextPhase === "compacting" || live.state.agentStatus === "compacting";
    live.state = {
      ...live.state,
      contextPhase: deriveContextPhase({
        contextTokens: live.sessionUsage?.contextTokens,
        contextTarget: live.sessionUsage?.contextTarget,
        contextWindow: live.sessionUsage?.contextWindow,
        compacting,
      }),
    };
    live.updatedAt = new Date().toISOString();
    emitStatePatch(live, previousView, projectLiveView(live));
    return {
      ...response(sessionId, "set_model", "accepted"),
      modelId: resolved.servedModelId || resolved.model.id,
    };
  }

  const delivery = command.type;
  const text = command.text.trim();
  // Resolve control/template slash before the busy gate so `/compact stop` can
  // abort an active turn (stop_and_compact) instead of being rejected as a prompt.
  const resolvedCmd =
    delivery === "prompt" ? resolveOperatorCommand(text) : { kind: "not_command" as const };
  if (resolvedCmd.kind === "unknown")
    return response(sessionId, "prompt", "failed", `Unknown command: /${resolvedCmd.command}`);
  if (resolvedCmd.kind === "invalid")
    return response(sessionId, "prompt", "failed", resolvedCmd.message);
  // Control slash → AgentCommand (never expand to a prompt template).
  if (resolvedCmd.kind === "control") {
    return dispatchSessionCommand(workspace, sessionId, resolvedCmd.agentCommand);
  }
  if (delivery === "prompt" && live.busy) {
    return response(sessionId, "prompt", "failed", "The Session already has an active turn");
  }
  if ((delivery === "steer" || delivery === "follow_up") && !live.busy) {
    return response(sessionId, delivery, "failed", "There is no active turn to redirect");
  }
  const effectiveText = resolvedCmd.kind === "expanded" ? resolvedCmd.prompt : text;
  if (delivery === "prompt") {
    if (
      live.handle.session.sessionManager.getSessionName()?.trim() === defaultSessionTitle(workspace)
    ) {
      const title = titleFromPrompt(text);
      if (title) live.handle.session.setSessionName(title);
    }
    live.busy = true;
    const acceptedTurnId = randomUUID();
    live.queueFixtureTurn?.(effectiveText, workspace.sources.length > 0);
    void live.handle.session
      .prompt(effectiveText)
      .catch((error) => {
        const previous = live.state;
        const previousView = projectLiveView(live, previous);
        const next = reducePiEvent(previous, "error", {
          type: "error",
          message: redactErrorMessage(error),
        });
        live.state = next;
        live.updatedAt = new Date().toISOString();
        emitStatePatch(live, previousView, projectLiveView(live, next));
      })
      .finally(() => {
        live.busy = false;
      });
    return { ...response(sessionId, "prompt", "accepted"), acceptedTurnId };
  }
  if (delivery === "steer") await live.handle.session.steer(text);
  else await live.handle.session.followUp(text);
  return { ...response(sessionId, delivery, "accepted"), acceptedTurnId: randomUUID() };
}
