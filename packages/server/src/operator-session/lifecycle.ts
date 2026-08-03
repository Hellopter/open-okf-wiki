/**
 * Operator Session lifecycle: create, list, delete, open, attach, snapshot, subscribe.
 */
import {
  createOperatorFixtureModel,
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSessionHistory,
  openOperatorSession,
  type RerunWikiNode,
  resolveWorkspacePiModel,
  type StartWikiRun,
  shouldUsePiFixtureMode,
} from "@okf-wiki/agent";
import {
  type AgentSseSnapshot,
  extractContextTokensFromPiMessage,
} from "@okf-wiki/contract/session";
import { createPiStreamState, type PiStreamState, reducePiEvent } from "@okf-wiki/contract/stream-server";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import {
  acquireWorkspaceActivityLease,
  resolveWikiSkillPaths,
  type WorkspaceActivityLease,
} from "@okf-wiki/core";
import { wikiRunsForWorkspace } from "../wiki-runs-registry.ts";
import {
  type BuiltHandle,
  key,
  type Listener,
  type ListenerSubscription,
  type LiveSession,
  liveSessions,
  openingLiveSessions,
  releaseLive,
} from "./registry.ts";
import {
  budgetFromSeat,
  emitStatePatch,
  projectLiveView,
  sessionModelFromParts,
  usageWithBudget,
} from "./project.ts";
import {
  assertLiveAvailable,
  assertWorkspaceAvailable,
  OperatorSessionWorkspaceDeletedError,
  withWorkspaceActivity,
} from "./workspace-guard.ts";

export function defaultSessionTitle(workspace: WorkspaceConfig): string {
  return `Wiki Agent: ${workspace.name.trim() || "workspace"}`;
}

export function titleFromPrompt(text: string): string | undefined {
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
    await assertWorkspaceAvailable(workspace);
    const runs = await wikiRunsForWorkspace(workspace);
    await assertWorkspaceAvailable(workspace);
    return runs.dispatch(
      {
        type: "start_run",
        commandId,
        intent: { mode, ...(notes?.trim() ? { focus: notes.trim().slice(0, 4_000) } : {}) },
      },
      {
        workspaceId: workspace.id,
        actor: { id: sessionId || defaultSessionId, kind: "operator_session" },
        sessionId: sessionId || defaultSessionId,
      },
    );
  };
}

function repairRunner(workspace: WorkspaceConfig, defaultSessionId: string): RerunWikiNode {
  return async ({ commandId, runId, nodeKey, generation, feedback, sessionId }) => {
    await assertWorkspaceAvailable(workspace);
    const runs = await wikiRunsForWorkspace(workspace);
    const { snapshot } = await runs.read({ runId });
    await assertWorkspaceAvailable(workspace);
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
        workspaceId: workspace.id,
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
    await assertWorkspaceAvailable(workspace);
    const { snapshot } = await (await wikiRunsForWorkspace(workspace)).read({ runId: input.runId });
    const nodeKey = input.nodeKey?.trim() || "write.root";
    const node = snapshot.nodes.find((candidate) => candidate.key === nodeKey);
    return node && !["freeze", "gate.plan", "gate.fix", "gate.publication"].includes(node.key)
      ? { nodeKey: node.key, generation: node.generation }
      : null;
  } catch (error) {
    if (error instanceof OperatorSessionWorkspaceDeletedError) throw error;
    return null;
  }
}

export async function makeHandle(workspace: WorkspaceConfig, sessionId?: string): Promise<BuiltHandle> {
  await assertWorkspaceAvailable(workspace);
  const fixture = shouldUsePiFixtureMode({});
  const fixtureModel = fixture ? await createOperatorFixtureModel() : undefined;
  await assertWorkspaceAvailable(workspace);
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
  await assertWorkspaceAvailable(workspace);
  const sessionIdentity = sessionId ?? "pending";
  const piModel = fixtureModel?.model ?? resolved?.model;
  const maxContextTokens = resolved?.runtime.maxContextTokens;
  const modelContextWindow =
    piModel && typeof piModel.contextWindow === "number" && piModel.contextWindow > 0
      ? piModel.contextWindow
      : undefined;
  const contextBudget = budgetFromSeat({
    maxContextTokens,
    modelContextWindow,
    contextTargetTokens: workspace.limits.contextTargetTokens,
  });
  const model = sessionModelFromParts({
    profileId: resolved?.runtime.profileId ?? workspace.model.profileId,
    modelId: resolved?.servedModelId ?? piModel?.id ?? workspace.model.id,
    name:
      (typeof piModel?.name === "string" && piModel.name.trim() ? piModel.name : undefined) ??
      resolved?.runtime.profileName,
  });
  const baseInput = {
    workspace,
    ...(fixtureModel
      ? { model: fixtureModel.model, modelRuntime: fixtureModel.modelRuntime }
      : resolved
        ? { model: resolved.model, modelRuntime: resolved.modelRuntime }
        : {}),
    additionalSkillPaths: skillPaths,
    contextTargetTokens: workspace.limits.contextTargetTokens,
    maxContextTokens,
    wikiProduce: {
      startWikiRun: runStarter(workspace, sessionIdentity),
      rerunWikiNode: repairRunner(workspace, sessionIdentity),
      resolveRepairTarget: (target: { runId: string; nodeKey?: string }) =>
        resolveRepairTarget(workspace, target),
    },
  };
  const handle = sessionId
    ? openOperatorSession({ ...baseInput, sessionId })
    : createOperatorSession(baseInput);
  const resolvedHandle = await handle;
  try {
    await assertWorkspaceAvailable(workspace);
  } catch (error) {
    resolvedHandle.dispose();
    throw error;
  }
  return {
    handle: resolvedHandle,
    model,
    contextBudget,
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

export async function attachLive(
  workspace: WorkspaceConfig,
  built: BuiltHandle,
  seed: PiStreamState,
  activityLease: WorkspaceActivityLease,
  contextTokens?: number,
): Promise<LiveSession> {
  await assertWorkspaceAvailable(workspace);
  const { handle, queueFixtureTurn, model, contextBudget } = built;
  // Prefer seat budget (window + target) over workspace target alone so the
  // meter denominators match Pi auto-compaction settings for this model.
  const initialUsage = usageWithBudget(contextBudget, contextTokens);
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
    activityLease,
    closed: false,
    ...(initialUsage ? { sessionUsage: initialUsage } : {}),
    ...(model ? { model } : {}),
    ...(contextBudget ? { contextBudget } : {}),
    ...(queueFixtureTurn ? { queueFixtureTurn } : {}),
  };
  const sessionKey = key(workspace.id, handle.sessionId);
  if (liveSessions.has(sessionKey)) {
    throw new Error(`Operator Session is already open: ${handle.sessionId}`);
  }
  live.unsubscribe = handle.session.subscribe((raw: unknown) => {
    const type =
      raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string"
        ? raw.type
        : "error";
    const previous = live.state;
    const previousView = projectLiveView(live, previous);
    const next = reducePiEvent(previous, type, raw);
    live.state = next;
    const body = raw && typeof raw === "object" && "message" in raw ? raw.message : undefined;
    const nextContextTokens = extractContextTokensFromPiMessage(body);
    if (nextContextTokens !== undefined) {
      live.sessionUsage = usageWithBudget(
        live.contextBudget,
        nextContextTokens,
        live.sessionUsage,
      );
    }
    live.updatedAt = new Date().toISOString();
    emitStatePatch(live, previousView, projectLiveView(live, next));
  });
  liveSessions.set(sessionKey, live);
  return live;
}

export async function openLive(workspace: WorkspaceConfig, sessionId: string): Promise<LiveSession> {
  await assertWorkspaceAvailable(workspace);
  const sessionKey = key(workspace.id, sessionId);
  const existing = liveSessions.get(sessionKey);
  if (existing) return existing;
  const pending = openingLiveSessions.get(sessionKey);
  if (pending) return pending;

  const opening = (async () => {
    const history = await loadOperatorSessionHistory(workspace.rootPath, sessionId);
    await assertWorkspaceAvailable(workspace);
    if (!history) throw new Error(`Operator Session not found: ${sessionId}`);
    const activityLease = await acquireWorkspaceActivityLease(workspace.rootPath, workspace.id);
    let built: BuiltHandle | undefined;
    try {
      built = await makeHandle(workspace, sessionId);
      return await attachLive(
        workspace,
        built,
        createPiStreamState(history.messages),
        activityLease,
        history.lastContextTokens,
      );
    } catch (error) {
      built?.handle.dispose();
      await activityLease.release();
      throw error;
    }
  })().finally(() => openingLiveSessions.delete(sessionKey));
  openingLiveSessions.set(sessionKey, opening);
  return opening;
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
  await assertWorkspaceAvailable(workspace);
  const activityLease = await acquireWorkspaceActivityLease(workspace.rootPath, workspace.id);
  let built: BuiltHandle | undefined;
  try {
    built = await buildHandle(workspace, sessionId);
    await assertWorkspaceAvailable(workspace);
    const sessionTitle = title?.trim() || defaultSessionTitle(workspace);
    built.handle.session.setSessionName(sessionTitle);
    const live = await attachLive(workspace, built, createPiStreamState(), activityLease);
    return { id: live.sessionId, title: sessionTitle, createdAt: live.createdAt };
  } catch (error) {
    built?.handle.dispose();
    await activityLease.release();
    throw error;
  }
}

export async function listSessions(
  workspace: WorkspaceConfig,
): Promise<Array<{ id: string; title?: string; createdAt: string; updatedAt: string }>> {
  return withWorkspaceActivity(workspace, async () => {
    const rows = new Map(
      (await listOperatorSessions(workspace.rootPath)).map((row) => [row.id, row]),
    );
    await assertWorkspaceAvailable(workspace);
    for (const live of liveSessions.values()) {
      if (live.workspaceId === workspace.id && !live.closed) {
        rows.set(live.sessionId, {
          id: live.sessionId,
          title: live.handle.session.sessionManager.getSessionName()?.trim() || undefined,
          createdAt: live.createdAt,
          updatedAt: live.updatedAt,
        });
      }
    }
    return [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

export async function deleteLiveSession(workspace: WorkspaceConfig, sessionId: string) {
  return withWorkspaceActivity(workspace, async () => {
    const live = liveSessions.get(key(workspace.id, sessionId));
    if (live) await releaseLive(live);
    await assertWorkspaceAvailable(workspace);
    const deleted = await deleteOperatorSession(workspace.rootPath, sessionId);
    return { sessionId, removed: deleted.deleted || Boolean(live) ? 1 : 0 };
  });
}

export async function sessionSnapshot(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<AgentSseSnapshot> {
  await assertWorkspaceAvailable(workspace);
  const live = await openLive(workspace, sessionId);
  await assertLiveAvailable(workspace, live);
  // Chrome is on both payload.session (attach identity) and state (stream reduce).
  const projected = projectLiveView(live);
  return {
    source: "server",
    kind: "snapshot",
    sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      session: {
        id: sessionId,
        workspaceId: workspace.id,
        ...(live.model ? { model: live.model } : {}),
        ...(live.contextBudget ? { contextBudget: live.contextBudget } : {}),
      },
      // `live.state` includes the durable branch plus finalized messages that
      // arrived after the session file was last flushed. The subsequent SSE
      // patches are diffed from this exact baseline.
      state: projected,
    },
  };
}

export async function subscribeSession(
  workspace: WorkspaceConfig,
  sessionId: string,
  listener: Listener,
  onClosed?: () => void,
): Promise<() => void> {
  await assertWorkspaceAvailable(workspace);
  const live = await openLive(workspace, sessionId);
  await assertLiveAvailable(workspace, live);
  const subscription: ListenerSubscription = {
    onEvent: listener,
    ...(onClosed ? { onClosed } : {}),
  };
  live.listeners.add(subscription);
  return () => live.listeners.delete(subscription);
}
