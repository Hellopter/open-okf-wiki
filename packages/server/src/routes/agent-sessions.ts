/** HTTP and SSE adapter for Pi-native Operator Sessions. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { listOperatorCommands, redactErrorMessage } from "@okf-wiki/agent";
import {
  type AgentSseEvent,
  CreatePiAgentSessionBodySchema,
  safeParseAgentCommand,
} from "@okf-wiki/contract";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";
import {
  createLiveSession,
  deleteLiveSession,
  dispatchSessionCommand,
  listSessions,
  sessionSnapshot,
  subscribeSession,
} from "../operator-sessions.ts";

const HEARTBEAT_MS = 15_000;

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
  sendJson(res, 200, { sessions: await listSessions(workspace) });
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
    sendError(res, /exists|duplicate/i.test(message) ? 409 : 500, message);
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
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendError(res, 500, redactErrorMessage(error));
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
  try {
    sendJson(res, 202, await dispatchSessionCommand(workspace, sessionId, parsed.data));
  } catch (error) {
    const message = redactErrorMessage(error);
    sendError(res, /not found/i.test(message) ? 404 : 500, message);
  }
}

function writeSse(res: ServerResponse, event: AgentSseEvent): void {
  if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
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
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  try {
    const pending: AgentSseEvent[] = [];
    let ready = false;
    unsubscribe = await subscribeSession(workspace, sessionId, (event) => {
      if (ready) writeSse(res, event);
      else pending.push(event);
    });
    const snapshot = await sessionSnapshot(workspace, sessionId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    writeSse(res, snapshot);
    for (const event of pending.splice(0)) writeSse(res, event);
    // The same subscriber crosses the snapshot cut, so a Pi event cannot be lost.
    ready = true;
    heartbeat = setInterval(
      () =>
        writeSse(res, {
          source: "server",
          kind: "heartbeat",
          sessionId,
          timestamp: new Date().toISOString(),
        }),
      HEARTBEAT_MS,
    );
    req.once("close", close);
    res.once("close", close);
  } catch (error) {
    unsubscribe();
    sendError(
      res,
      /not found/i.test(redactErrorMessage(error)) ? 404 : 500,
      redactErrorMessage(error),
    );
  }
}
