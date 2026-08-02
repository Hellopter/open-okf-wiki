/**
 * Minimal live host for Pi-backed Operator Sessions.
 *
 * Pi's SessionManager remains the durable conversation store and WikiRuns
 * remains the durable workflow store. This module only owns live handles and
 * projects genuine Pi events to the browser.
 */
import { randomUUID } from "node:crypto";
import {
  createOperatorFixtureModel,
  createOperatorSession,
  deleteOperatorSession,
  expandOperatorCommand,
  listOperatorSessions,
  loadOperatorSessionHistory,
  openOperatorSession,
  type RerunWikiNode,
  redactErrorMessage,
  redactSensitiveText,
  resolveWorkspacePiModel,
  type StartWikiRun,
  shouldUsePiFixtureMode,
} from "@okf-wiki/agent";
import {
  type AgentCommand,
  type AgentCommandResponse,
  type AgentMessage,
  type AgentSseEvent,
  type AgentSseSnapshot,
  type AgentSseStream,
  createPiStreamState,
  diffStreamState,
  type PiStreamState,
  reducePiEvent,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { loadWorkspace, resolveWikiSkillPaths } from "@okf-wiki/core";
import { wikiRunsForWorkspace } from "./wiki-runs-registry.ts";

type SessionHandle = Awaited<ReturnType<typeof createOperatorSession>>;
type Listener = (event: AgentSseEvent) => void;
type FixtureTurnQueue = (text: string, canProduce: boolean) => void;
type BuiltHandle = {
  handle: SessionHandle;
  queueFixtureTurn?: FixtureTurnQueue;
};

type LiveSession = {
  workspaceId: string;
  sessionId: string;
  handle: SessionHandle;
  state: PiStreamState;
  listeners: Set<Listener>;
  busy: boolean;
  createdAt: string;
  updatedAt: string;
  unsubscribe: () => void;
  queueFixtureTurn?: FixtureTurnQueue;
};

const liveSessions = new Map<string, LiveSession>();

function key(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

function defaultSessionTitle(workspace: WorkspaceConfig): string {
  return `Wiki Agent: ${workspace.name.trim() || "workspace"}`;
}

function titleFromPrompt(text: string): string | undefined {
  const firstLine = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

function runStarter(workspace: WorkspaceConfig, defaultSessionId: string): StartWikiRun {
  return async ({ commandId, sessionId, mode, notes }) => {
    const current = await loadWorkspace(workspace.rootPath);
    return (await wikiRunsForWorkspace(current)).dispatch(
      {
        type: "start_run",
        commandId,
        intent: { mode, ...(notes?.trim() ? { focus: notes.trim().slice(0, 4_000) } : {}) },
      },
      {
        workspaceId: current.id,
        actor: { id: sessionId || defaultSessionId, kind: "operator_session" },
        sessionId: sessionId || defaultSessionId,
      },
    );
  };
}

function repairRunner(workspace: WorkspaceConfig, defaultSessionId: string): RerunWikiNode {
  return async ({ commandId, runId, nodeKey, generation, feedback, sessionId }) => {
    const current = await loadWorkspace(workspace.rootPath);
    const runs = await wikiRunsForWorkspace(current);
    const { snapshot } = await runs.read({ runId });
    return runs.dispatch(
      {
        type: "rerun_node",
        commandId,
        runId,
        expectedRevision: snapshot.revision,
        nodeKey,
        generation,
        ...(feedback ? { feedback } : {}),
      },
      {
        workspaceId: current.id,
        actor: { id: sessionId || defaultSessionId, kind: "operator_session" },
        sessionId: sessionId || defaultSessionId,
      },
    );
  };
}

async function resolveRepairTarget(
  workspace: WorkspaceConfig,
  input: { runId: string; nodeKey?: string },
): Promise<{ nodeKey: string; generation: number } | null> {
  try {
    const current = await loadWorkspace(workspace.rootPath);
    const { snapshot } = await (await wikiRunsForWorkspace(current)).read({ runId: input.runId });
    const key = input.nodeKey?.trim() || "write.root";
    const node = snapshot.nodes.find((candidate) => candidate.key === key);
    return node && !["freeze", "gate.plan", "gate.fix", "gate.publication"].includes(node.key)
      ? { nodeKey: node.key, generation: node.generation }
      : null;
  } catch {
    return null;
  }
}

async function makeHandle(workspace: WorkspaceConfig, sessionId?: string): Promise<BuiltHandle> {
  const fixture = shouldUsePiFixtureMode({});
  const fixtureModel = fixture ? await createOperatorFixtureModel() : undefined;
  const resolved = fixtureModel
    ? undefined
    : await resolveWorkspacePiModel({
        profileId: workspace.model.profileId,
        modelId: workspace.model.id,
      });
  const skillPaths = await resolveWikiSkillPaths({
    workspaceRoot: workspace.rootPath,
    skillPath: workspace.skillPath,
  });
  const sessionIdentity = sessionId ?? "pending";
  const baseInput = {
    workspace,
    ...(fixtureModel
      ? { model: fixtureModel.model, modelRuntime: fixtureModel.modelRuntime }
      : resolved
        ? { model: resolved.model, modelRuntime: resolved.modelRuntime }
        : {}),
    additionalSkillPaths: skillPaths,
    contextTargetTokens: workspace.limits.contextTargetTokens,
    maxContextTokens: resolved?.runtime.maxContextTokens,
    wikiProduce: {
      startWikiRun: runStarter(workspace, sessionIdentity),
      rerunWikiNode: repairRunner(workspace, sessionIdentity),
      resolveRepairTarget: (target: { runId: string; nodeKey?: string }) =>
        resolveRepairTarget(workspace, target),
      resolveWorkspace: () => loadWorkspace(workspace.rootPath),
    },
  };
  const handle = sessionId
    ? openOperatorSession({ ...baseInput, sessionId })
    : createOperatorSession(baseInput);
  return {
    handle: await handle,
    ...(fixtureModel
      ? {
          queueFixtureTurn: (text: string, canProduce: boolean) => {
            if (canProduce) fixtureModel.queueWikiProduceTurn(text);
            else fixtureModel.queueAssistantTurn();
          },
        }
      : {}),
  };
}

function emit(live: LiveSession, event: AgentSseEvent): void {
  for (const listener of live.listeners) listener(event);
}

/**
 * Pi holds the authoritative conversation record, including provider reasoning
 * and raw tool payloads. The browser is an operator surface, not a Pi mirror:
 * expose only text, a tool lifecycle, and the bounded WikiRun receipt.
 */
function projectOperatorMessage(message: AgentMessage): AgentMessage | null {
  if (message.role === "system" || message.role === "tool") return null;
  const tools = message.tools?.map((tool) => ({
    id: tool.id,
    name: tool.name,
    status: tool.status,
    ...(tool.details
      ? {
          details: {
            status: tool.details.status,
            ...(tool.details.runId ? { runId: tool.details.runId } : {}),
            ...(tool.details.summary ? { summary: redactSensitiveText(tool.details.summary) } : {}),
          },
        }
      : {}),
    ...(tool.name === "wiki_repair" && tool.args && typeof tool.args === "object"
      ? (() => {
          const runId = (tool.args as Record<string, unknown>).runId;
          return typeof runId === "string" && runId.trim() ? { args: { runId: runId.trim() } } : {};
        })()
      : {}),
  }));
  const parts = message.parts
    ?.filter((part) => part.type !== "thinking")
    .map((part) =>
      part.type === "text" ? { ...part, text: redactSensitiveText(part.text) } : part,
    );
  return {
    id: message.id,
    role: message.role,
    content: redactSensitiveText(message.content),
    createdAt: message.createdAt,
    ...(tools?.length ? { tools } : {}),
    ...(parts?.length ? { parts } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.errorText ? { errorText: redactErrorMessage(message.errorText) } : {}),
  };
}

/** A dedicated, secret-free wire projection for the browser Session SSE. */
export function projectOperatorStreamState(state: PiStreamState): PiStreamState {
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
    ...state,
    messages,
    streamingMessage,
    lastAssistantId,
    errorText: state.errorText ? redactErrorMessage(state.errorText) : null,
  };
}

function emitStatePatch(live: LiveSession, previous: PiStreamState, next: PiStreamState): void {
  emit(live, {
    source: "server",
    kind: "stream",
    sessionId: live.sessionId,
    timestamp: live.updatedAt,
    payload: diffStreamState(
      projectOperatorStreamState(previous),
      projectOperatorStreamState(next),
    ),
  } satisfies AgentSseStream);
}

function attachLive(
  workspace: WorkspaceConfig,
  built: BuiltHandle,
  seed: PiStreamState,
): LiveSession {
  const { handle, queueFixtureTurn } = built;
  const live: LiveSession = {
    workspaceId: workspace.id,
    sessionId: handle.sessionId,
    handle,
    state: seed,
    listeners: new Set(),
    busy: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    unsubscribe: () => undefined,
    ...(queueFixtureTurn ? { queueFixtureTurn } : {}),
  };
  live.unsubscribe = handle.session.subscribe((raw: unknown) => {
    const type =
      raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string"
        ? raw.type
        : "error";
    const previous = live.state;
    const next = reducePiEvent(previous, type, raw);
    live.state = next;
    live.updatedAt = new Date().toISOString();
    emitStatePatch(live, previous, next);
  });
  liveSessions.set(key(workspace.id, handle.sessionId), live);
  return live;
}

async function openLive(workspace: WorkspaceConfig, sessionId: string): Promise<LiveSession> {
  const existing = liveSessions.get(key(workspace.id, sessionId));
  if (existing) return existing;
  const history = await loadOperatorSessionHistory(workspace.rootPath, sessionId);
  if (!history) throw new Error(`Operator Session not found: ${sessionId}`);
  return attachLive(
    workspace,
    await makeHandle(workspace, sessionId),
    createPiStreamState(history.messages),
  );
}

export async function createLiveSession(
  workspace: WorkspaceConfig,
  title?: string,
  sessionId?: string,
  buildHandle: (
    workspace: WorkspaceConfig,
    sessionId?: string,
  ) => Promise<BuiltHandle> = makeHandle,
) {
  const built = await buildHandle(workspace, sessionId);
  const sessionTitle = title?.trim() || defaultSessionTitle(workspace);
  built.handle.session.setSessionName(sessionTitle);
  const live = attachLive(workspace, built, createPiStreamState());
  return { id: live.sessionId, title: sessionTitle, createdAt: live.createdAt };
}

export async function listSessions(
  workspace: WorkspaceConfig,
): Promise<Array<{ id: string; title?: string; createdAt: string; updatedAt: string }>> {
  const rows = new Map(
    (await listOperatorSessions(workspace.rootPath)).map((row) => [row.id, row]),
  );
  for (const live of liveSessions.values()) {
    if (live.workspaceId === workspace.id) {
      rows.set(live.sessionId, {
        id: live.sessionId,
        title: live.handle.session.sessionManager.getSessionName()?.trim() || undefined,
        createdAt: live.createdAt,
        updatedAt: live.updatedAt,
      });
    }
  }
  return [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteLiveSession(workspace: WorkspaceConfig, sessionId: string) {
  const live = liveSessions.get(key(workspace.id, sessionId));
  if (live) {
    live.unsubscribe();
    live.handle.dispose();
    liveSessions.delete(key(workspace.id, sessionId));
  }
  const deleted = await deleteOperatorSession(workspace.rootPath, sessionId);
  return { sessionId, removed: deleted.deleted || Boolean(live) ? 1 : 0 };
}

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
  const live = await openLive(workspace, sessionId);
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
    if (command.mode === "stop_and_compact") await live.handle.session.abort();
    void live.handle.session.compact().catch(() => undefined);
    return response(sessionId, "compact", "accepted");
  }
  if (command.type === "set_model") {
    if (live.busy) return response(sessionId, "set_model", "failed", "Wait for the current turn");
    const model = await resolveWorkspacePiModel({ profileId: command.profileId });
    await live.handle.session.setModel(model.model);
    return { ...response(sessionId, "set_model", "accepted"), modelId: model.model.id };
  }

  const delivery = command.type;
  if (delivery === "prompt" && live.busy) {
    return response(sessionId, "prompt", "failed", "The Session already has an active turn");
  }
  if ((delivery === "steer" || delivery === "follow_up") && !live.busy) {
    return response(sessionId, delivery, "failed", "There is no active turn to redirect");
  }
  const text = command.text.trim();
  const expansion =
    delivery === "prompt" ? expandOperatorCommand(text) : { kind: "not_command" as const };
  if (expansion.kind === "unknown")
    return response(sessionId, "prompt", "failed", `Unknown command: /${expansion.command}`);
  const effectiveText = expansion.kind === "expanded" ? expansion.prompt : text;
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
        const next = reducePiEvent(previous, "error", {
          type: "error",
          message: redactErrorMessage(error),
        });
        live.state = next;
        live.updatedAt = new Date().toISOString();
        emitStatePatch(live, previous, next);
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

export async function sessionSnapshot(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<AgentSseSnapshot> {
  const live = await openLive(workspace, sessionId);
  const projected = projectOperatorStreamState(live.state);
  return {
    source: "server",
    kind: "snapshot",
    sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      session: { id: sessionId, workspaceId: workspace.id },
      // `live.state` includes the durable branch plus finalized messages that
      // arrived after the session file was last flushed. The subsequent SSE
      // patches are diffed from this exact baseline.
      messages: projected.messages,
      contextPhase: projected.contextPhase,
    },
  };
}

export async function subscribeSession(
  workspace: WorkspaceConfig,
  sessionId: string,
  listener: Listener,
): Promise<() => void> {
  const live = await openLive(workspace, sessionId);
  live.listeners.add(listener);
  return () => live.listeners.delete(listener);
}

export function closeOperatorSessions(): void {
  for (const live of liveSessions.values()) {
    live.unsubscribe();
    live.handle.dispose();
  }
  liveSessions.clear();
}
