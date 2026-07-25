/** Pi-native Operator Session authority (ADR 0032). */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  type ModelRuntime,
  type SessionInfo,
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { projectWikiProduceDetailsForHistory, type WorkspaceConfig } from "@okf-wiki/contract";
import { deleteSessionRuns, isPathInside, WORKSPACE_DIR_NAME } from "@okf-wiki/core";
import {
  type CreateWikiProduceToolInput,
  createWikiProduceTool,
} from "../produce/wiki-produce-tool.js";
import { createWikiRepairTool } from "../tools/wiki-repair.js";
import { createWikiSession, type WikiSessionHandle } from "./create-wiki-session.js";
import { createSessionStatusTool } from "./session-status-tool.js";

/** Pi JSONL session tree root for a workspace. */
export function piSessionsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_DIR_NAME, "pi-sessions");
}

/** Durable SessionManager branch — Pi owns the message shape. */
export type OperatorSessionHistory = {
  sessionId: string;
  messages: Message[];
};

export type OperatorSessionSummary = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

type OperatorWikiProduceInput = Omit<CreateWikiProduceToolInput, "workspace" | "sessionId">;

type OperatorSessionRuntimeInput = {
  workspace: WorkspaceConfig;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  systemPrompt?: string;
  additionalSkillPaths?: readonly string[];
  maxContextTokens?: number;
  contextTargetTokens?: number;
  wikiProduce: OperatorWikiProduceInput;
};

export type CreateOperatorSessionInput = OperatorSessionRuntimeInput & {
  sessionId?: string;
};

export type OpenOperatorSessionInput = OperatorSessionRuntimeInput & {
  sessionId: string;
};

export type OperatorSessionHandle = WikiSessionHandle & {
  sessionId: string;
};

function workspaceRoot(workspaceRootInput: string): string {
  const root = path.resolve(workspaceRootInput);
  if (!root.trim()) throw new Error("workspaceRoot is required");
  return root;
}

/** SessionManager.list is the only session index. It also filters out foreign cwd sessions. */
async function listSessionInfo(workspaceRootInput: string): Promise<SessionInfo[]> {
  const root = workspaceRoot(workspaceRootInput);
  return SessionManager.list(root, piSessionsDir(root));
}

async function findSessionInfo(
  workspaceRootInput: string,
  sessionId: string,
): Promise<SessionInfo | null> {
  const id = sessionId.trim();
  if (!id) return null;
  return (await listSessionInfo(workspaceRootInput)).find((session) => session.id === id) ?? null;
}

export async function listOperatorSessions(
  workspaceRootInput: string,
): Promise<OperatorSessionSummary[]> {
  return (await listSessionInfo(workspaceRootInput)).map((session) => ({
    id: session.id,
    title: session.name?.trim() || session.firstMessage?.trim() || undefined,
    createdAt: session.created.toISOString(),
    updatedAt: session.modified.toISOString(),
  }));
}

async function buildOperatorSession(
  input: OperatorSessionRuntimeInput,
  manager: SessionManager,
): Promise<OperatorSessionHandle> {
  const root = workspaceRoot(input.workspace.rootPath);
  const sessionId = manager.getSessionId();
  const sessionStatus = createSessionStatusTool({
    workspace: input.workspace,
    model: input.model,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
  });
  const wikiProduce = createWikiProduceTool({
    ...input.wikiProduce,
    workspace: input.workspace,
    sessionId,
  });
  const wikiRepair = createWikiRepairTool({
    workspace: input.workspace,
    resolveWorkspace: input.wikiProduce.resolveWorkspace,
    sessionId,
    resolveModel: input.wikiProduce.resolveModel,
    fixture: input.wikiProduce.fixture,
  });
  const handle = await createWikiSession({
    role: "operator_chat",
    runWorkDir: root,
    sessionManager: manager,
    model: input.model,
    modelRuntime: input.modelRuntime,
    systemPrompt: input.systemPrompt,
    agentDir: path.join(root, WORKSPACE_DIR_NAME),
    additionalSkillPaths: input.additionalSkillPaths,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    scopedTools: false,
    // status first so meta questions prefer it over wiki_produce / wiki_repair
    customTools: [sessionStatus, wikiProduce, wikiRepair],
  });
  return { ...handle, sessionId };
}

/** Create a new Pi Operator Session. Duplicate ids are rejected, never merged. */
export async function createOperatorSession(
  input: CreateOperatorSessionInput,
): Promise<OperatorSessionHandle> {
  const root = workspaceRoot(input.workspace.rootPath);
  const sessionDir = piSessionsDir(root);
  await mkdir(sessionDir, { recursive: true });
  const requestedId = input.sessionId?.trim();
  if (requestedId && (await findSessionInfo(root, requestedId))) {
    throw new Error(`Operator Session already exists: ${requestedId}`);
  }
  const manager = SessionManager.create(
    root,
    sessionDir,
    requestedId ? { id: requestedId } : undefined,
  );
  return buildOperatorSession(input, manager);
}

/** Open one exact SessionManager id; there is no filename or legacy discovery fallback. */
export async function openOperatorSession(
  input: OpenOperatorSessionInput,
): Promise<OperatorSessionHandle> {
  const root = workspaceRoot(input.workspace.rootPath);
  const info = await findSessionInfo(root, input.sessionId);
  if (!info) throw new Error(`Operator Session not found: ${input.sessionId}`);
  const manager = SessionManager.open(info.path, piSessionsDir(root), root);
  return buildOperatorSession(input, manager);
}

/**
 * Operator-facing history projection of one Pi message.
 * Clones wiki_produce toolResult.details to a durable (lean) shape; does not
 * mutate SessionManager-owned objects.
 */
export function projectOperatorHistoryMessage(message: Message): Message {
  if (!message || typeof message !== "object") return message;
  const row = message as Message & {
    role?: string;
    toolName?: string;
    details?: unknown;
  };
  if (row.role !== "toolResult") return message;
  // Always project: projectWikiProduceDetailsForHistory no-ops unless status is a wiki_produce status.
  if (!("details" in row) || row.details == null) return message;
  const projected = projectWikiProduceDetailsForHistory(row.details);
  if (projected === row.details) return message;
  return { ...row, details: projected } as Message;
}

/**
 * Operator UI history from a SessionManager: Pi compaction-aware context path
 * (same idea as TUI `buildContextEntries` + `sessionEntryToContextMessages`),
 * then product-side durable details strip. Does not rewrite JSONL.
 */
export function projectOperatorHistoryFromManager(manager: SessionManager): Message[] {
  return manager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry) as Message[])
    .map((message) => projectOperatorHistoryMessage(message));
}

/** Read compaction-aware operator history (not the full unsummarized branch). */
export async function loadOperatorSessionHistory(
  workspaceRootInput: string,
  sessionId: string,
): Promise<OperatorSessionHistory | null> {
  const root = workspaceRoot(workspaceRootInput);
  const info = await findSessionInfo(root, sessionId);
  if (!info) return null;
  const manager = SessionManager.open(info.path, piSessionsDir(root), root);
  return {
    sessionId: manager.getSessionId(),
    messages: projectOperatorHistoryFromManager(manager),
  };
}

/** Delete the Session JSONL and all v2 Run work owned by that Session. */
export async function deleteOperatorSession(
  workspaceRootInput: string,
  sessionId: string,
): Promise<{ deleted: boolean; removedRunIds: string[] }> {
  const root = workspaceRoot(workspaceRootInput);
  const info = await findSessionInfo(root, sessionId);
  const removedRunIds = await deleteSessionRuns(root, sessionId);
  if (!info) return { deleted: false, removedRunIds };

  const sessionDir = piSessionsDir(root);
  if (!isPathInside(sessionDir, info.path)) {
    throw new Error("SessionManager returned a path outside pi-sessions");
  }
  await rm(info.path, { force: true });
  return { deleted: true, removedRunIds };
}
