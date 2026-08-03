/** HTTP and SSE adapter for Pi-native Operator Sessions. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { listOperatorCommands, redactErrorMessage } from "@okf-wiki/agent";
import { type AgentSseEvent, CreatePiAgentSessionBodySchema, safeParseAgentCommand } from "@okf-wiki/contract/session";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";
import { getLogger } from "../logging/index.ts";
import {
  createLiveSession,
  deleteLiveSession,
  dispatchSessionCommand,
  listSessions,
  OperatorSessionWorkspaceDeletedError,
  sessionSnapshot,
  subscribeSession,
} from "../operator-sessions.ts";
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  endSseResponse,
  openSseResponse,
  writeSseData,
} from "../sse/framing.ts";

function sessionErrorStatus(error: unknown): number {
  if (error instanceof OperatorSessionWorkspaceDeletedError) return 404;
  return /not found/i.test(redactErrorMessage(error)) ? 404 : 500;
}

export function handleListOperatorCommands(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    commands: listOperatorCommands().map(({ name, description, argumentHint }) => ({
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
    })),
  });
}

export async function handleListAgentSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    sendJson(res, 200, { sessions: await listSessions(workspace) });
  } catch (error) {
    sendError(res, sessionErrorStatus(error), redactErrorMessage(error));
  }
}

export async function handleCreateAgentSession(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const parsed = CreatePiAgentSessionBodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success)
    return sendError(res, 400, "invalid create session body", parsed.error.flatten());
  try {
    const session = await createLiveSession(workspace, parsed.data.title, parsed.data.sessionId);
    getLogger().info(
      { event: "session.create", workspaceId: workspace.id, sessionId: session.id },
      "operator session created",
    );
    sendJson(res, 201, {
      session: {
        id: session.id,
        workspaceId: workspace.id,
        title: session.title || `Wiki Agent · ${workspace.name}`,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    const message = redactErrorMessage(error);
    const status =
      error instanceof OperatorSessionWorkspaceDeletedError
        ? 404
        : /exists|duplicate/i.test(message)
          ? 409
          : 500;
    getLogger()[status >= 500 ? "error" : "warn"](
      { event: "session.create", workspaceId: workspace.id, err: message },
      "operator session create failed",
    );
    sendError(res, status, message);
  }
}

export async function handleDeleteAgentSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const result = await deleteLiveSession(workspace, sessionId);
    if (result.removed === 0) return sendError(res, 404, `agent session not found: ${sessionId}`);
    getLogger().info(
      { event: "session.delete", workspaceId: workspace.id, sessionId },
      "operator session deleted",
    );
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    getLogger().error(
      {
        event: "session.delete",
        workspaceId: workspace.id,
        sessionId,
        err: redactErrorMessage(error),
      },
      "operator session delete failed",
    );
    sendError(res, sessionErrorStatus(error), redactErrorMessage(error));
  }
}

export async function handleAgentSessionCommand(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const parsed = safeParseAgentCommand(await readJsonBody(req));
  if (!parsed.success) return sendError(res, 400, "invalid agent command", parsed.error.flatten());
  const commandName = parsed.data.type;
  try {
    const result = await dispatchSessionCommand(workspace, sessionId, parsed.data);
    getLogger().info(
      {
        event: "session.command",
        workspaceId: workspace.id,
        sessionId,
        command: commandName,
      },
      "operator session command accepted",
    );
    sendJson(res, 202, result);
  } catch (error) {
    const message = redactErrorMessage(error);
    const status = sessionErrorStatus(error);
    getLogger()[status >= 500 ? "error" : "warn"](
      {
        event: "session.command",
        workspaceId: workspace.id,
        sessionId,
        command: commandName,
        err: message,
      },
      "operator session command failed",
    );
    sendError(res, status, message);
  }
}

export async function handleAgentSessionEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  let unsubscribe: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    endSseResponse(res);
    getLogger().debug(
      { event: "session.sse", workspaceId: workspace.id, sessionId, phase: "close" },
      "session SSE closed",
    );
  };
  try {
    const pending: AgentSseEvent[] = [];
    let ready = false;
    unsubscribe = await subscribeSession(
      workspace,
      sessionId,
      (event) => {
        // Session Pi SSE uses data-only frames (payload carries `kind`).
        if (ready) writeSseData(res, event);
        else pending.push(event);
      },
      close,
    );
    const snapshot = await sessionSnapshot(workspace, sessionId);
    openSseResponse(res);
    getLogger().debug(
      { event: "session.sse", workspaceId: workspace.id, sessionId, phase: "open" },
      "session SSE open",
    );
    writeSseData(res, snapshot);
    for (const event of pending.splice(0)) writeSseData(res, event);
    // The same subscriber crosses the snapshot cut, so a Pi event cannot be lost.
    ready = true;
    heartbeat = setInterval(
      () =>
        writeSseData(res, {
          source: "server",
          kind: "heartbeat",
          sessionId,
          timestamp: new Date().toISOString(),
        }),
      DEFAULT_SSE_HEARTBEAT_MS,
    );
    req.once("close", close);
    res.once("close", close);
  } catch (error) {
    unsubscribe();
    sendError(res, sessionErrorStatus(error), redactErrorMessage(error));
  }
}
