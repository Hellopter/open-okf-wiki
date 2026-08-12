import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { WikiCheckpointCoordinator } from "./checkpoint.js";
import { WikiWorkflowApplication } from "./application.js";
import { createPiAgentExecutor } from "./executor.js";
import { createWikiWorkflowEngine, type WikiWorkflowEngine } from "./engine.js";
import { createWikiUiHost, notifyRunStarted, type WikiUiHost } from "./ui/host.js";
import type { WikiNavigatorController, WikiNavigatorWorkspace } from "./ui/model.js";
import { renderWikiArtifactText, renderWikiRunHistoryText, renderWikiRunText } from "./ui/text.js";
import { createWikiRunHistoryStore, summarizeWikiRun, type WikiRunHistoryStore } from "./run-history.js";
import { createWikiPublicationStore, type WikiPublicationStore } from "./publication-store.js";
import { createWikiRunSession, parseWikiRunSession, WIKI_RUN_CUSTOM_TYPE } from "./session.js";
import { explainWikiRunSnapshot } from "./snapshot-validation.js";
import { projectWikiRunView } from "./run-view.js";
import type { WikiRunEvent, WikiRunSession, WikiRunSnapshot, WikiRunSummary } from "./workflow-types.js";
import { errorMessage, isRecord } from "./util.js";
import { wikiWorkspaceService, type WikiWorkspaceResult, type WikiWorkspaceService } from "./workspace.js";
import { isActiveRunStatus, isTerminalRunStatus } from "./ui/format.js";
import {
  createWikiWorkspaceCoordinator,
  type WikiWorkspaceCoordinator,
  type WikiWorkspaceLock,
  type WikiWorkspaceOwner,
} from "./workspace-coordinator.js";

export interface WikiExtensionOptions {
  createEngine?: (context: ExtensionContext) => WikiWorkflowEngine;
  workspaceService?: WikiWorkspaceService;
  /** Test seam for project-scoped durable Wiki run history. */
  createHistoryStore?: (workspace: string) => WikiRunHistoryStore;
  /** Test seam for workspace-local candidate publication and crash recovery. */
  createPublicationStore?: (workspace: string) => WikiPublicationStore;
  /** Test seam for workspace-local process ownership. */
  createWorkspaceCoordinator?: (workspace: string) => WikiWorkspaceCoordinator;
}

interface ParsedRunCommand {
  action: "open" | "generate" | "refresh" | "status" | "history" | "pause" | "resume" | "stop" | "cancel" | "help";
  focus?: string;
  language?: "zh" | "en";
  runId?: string;
}

interface ParsedArtifactsCommand {
  action: "artifacts";
  runId?: string;
}

type ParsedCommand = ParsedRunCommand
  | ParsedArtifactsCommand
  | { action: "init"; workspace?: string; language?: "zh" | "en" }
  | { action: "source-add"; workspace?: string; source: { kind: "link"; path: string } | { kind: "clone"; url: string; ref?: string } };

/**
 * Pi extension entry point. The engine is intentionally Wiki-specific; generic
 * workflow state, saved commands, and a CLI are not installed.
 */
export function createWikiExtension(options: WikiExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    let engine: WikiWorkflowEngine | undefined;
    const applications = new Map<string, { engine: WikiWorkflowEngine; application: WikiWorkflowApplication }>();
    let unsubscribeEngine: (() => void) | undefined;
    let host: WikiUiHost | undefined;
    const historyWriteFailures = new Map<string, string>();
    let persistenceErrorReporter: ((message: string) => void) | undefined;
    const workspaceService = options.workspaceService ?? wikiWorkspaceService;
    const historyStores = new Map<string, WikiRunHistoryStore>();
    const publicationStores = new Map<string, WikiPublicationStore>();
    const historySummaries = new Map<string, WikiRunSummary[]>();
    const cachedSnapshots = new Map<string, WikiRunSnapshot>();
    const historyListeners = new Set<() => void>();
    const workspaceCoordinators = new Map<string, WikiWorkspaceCoordinator>();
    const workspaceLocks = new Map<string, WikiWorkspaceLock>();
    const checkpoints = new Map<string, WikiCheckpointCoordinator>();

    const checkpointFor = (workspace: string): WikiCheckpointCoordinator => {
      const root = path.resolve(workspace);
      let checkpoint = checkpoints.get(root);
      if (!checkpoint) {
        checkpoint = new WikiCheckpointCoordinator({
          appendSession: (session) => pi.appendEntry(WIKI_RUN_CUSTOM_TYPE, session),
          saveHistory: async (snapshot) => {
            rememberSnapshot(snapshot);
            await historyStoreFor(root).save(snapshot);
            await refreshHistory(root);
          },
        });
        checkpoints.set(root, checkpoint);
      }
      return checkpoint;
    };

    const createEngine = (context: ExtensionContext): WikiWorkflowEngine => options.createEngine?.(context) ?? createWikiWorkflowEngine({
      executor: createPiAgentExecutor({
        getModel: () => context.model,
        getThinkingLevel: () => context.thinkingLevel,
      }),
    });

    const reportHistoryFailure = (workspace: string, error: unknown): void => {
      const root = path.resolve(workspace);
      const message = `Wiki run history could not be saved: ${errorMessage(error)}`;
      if (historyWriteFailures.get(root) !== message) {
        console.warn(`[okf-wiki] ${message}`);
        persistenceErrorReporter?.(message);
      }
      historyWriteFailures.set(root, message);
    };

    const persistSnapshot = async (snapshot: WikiRunSnapshot): Promise<boolean> => {
      const checkpoint = checkpointFor(snapshot.cwd);
      try {
        await checkpoint.checkpoint(snapshot, { durable: true });
        historyWriteFailures.delete(path.resolve(snapshot.cwd));
        return true;
      } catch (error) {
        reportHistoryFailure(snapshot.cwd, error);
        return false;
      }
    };

    const persistNow = async (): Promise<boolean> => {
      // Prefer the live snapshot body; convert to pointer for host session.
      const snapshot = engine?.getSnapshot();
      return snapshot ? await persistSnapshot(snapshot) : true;
    };

    const bindEngine = (context: ExtensionContext): WikiWorkflowEngine => {
      unsubscribeEngine?.();
      const boundEngine = createEngine(context);
      engine = boundEngine;
      unsubscribeEngine = boundEngine.subscribe((snapshot, event) => {
        rememberSnapshot(snapshot);
        // Host session + history: only lifecycle / node-terminal / recovered / retry.
        // node_activity / node_started never appendEntry (OOM: host fileEntries).
        if (isCriticalEvent(event)) {
          void (async () => {
            if (isTerminalRunStatus(snapshot.status)) {
              await boundEngine.waitForIdle();
              const settled = boundEngine.getSnapshot();
              if (!settled || settled.id !== snapshot.id || !isTerminalRunStatus(settled.status)) return;
              if (await persistSnapshot(settled)) await releaseWorkspace(settled.cwd, settled.id);
              return;
            }
            await persistSnapshot(snapshot);
          })();
        }
      });
      return boundEngine;
    };

    const currentEngine = (context: ExtensionContext): WikiWorkflowEngine => engine ?? bindEngine(context);

    const applicationFor = (context: ExtensionContext, workspaceRoot: string): WikiWorkflowApplication => {
      return applicationForEngine(currentEngine(context), workspaceRoot);
    };

    const applicationForEngine = (active: WikiWorkflowEngine, workspaceRoot: string): WikiWorkflowApplication => {
      const root = path.resolve(workspaceRoot);
      const existing = applications.get(root);
      if (existing?.engine === active) return existing.application;
      if (existing) throw new Error(`Wiki application for ${root} is bound to a stale engine`);
      const application = new WikiWorkflowApplication({
        engine: active,
        acquire: async (runId) => {
          const existingLock = workspaceLocks.get(root);
          const lock = await requireWorkspace(root, runId);
          let released = false;
          return {
            acquired: existingLock !== lock,
            update: async (nextRunId) => {
              if (released) throw new Error("Wiki workspace ownership was already released");
              await coordinatorFor(root).updateRun(lock, nextRunId);
            },
            release: async () => {
              if (released || workspaceLocks.get(root) !== lock) return;
              await coordinatorFor(root).release(lock);
              if (workspaceLocks.get(root) === lock) workspaceLocks.delete(root);
              released = true;
            },
          };
        },
        persist: async (snapshot) => {
          if (!await persistSnapshot(snapshot)) throw checkpointFor(root).lastError() ?? new Error("Wiki checkpoint failed");
        },
        flush: async () => await checkpointFor(root).flush(),
        loadRun: async (runId) => await historyStoreFor(root).load(runId),
        listRecoverable: async (exceptRunId) => {
          const summaries = (await historyStoreFor(root).listFresh())
            .filter((summary) => isRecoverableRunStatus(summary.status) && summary.id !== exceptRunId);
          const snapshots = await Promise.all(summaries.map(async (summary) => await historyStoreFor(root).load(summary.id)));
          return snapshots.filter((snapshot): snapshot is WikiRunSnapshot => Boolean(snapshot));
        },
        bindLatestRecoverable: async () => await bindLatestRecoverable(active, root),
        bindRecoverable: async (runId) => await bindRecoverableById(active, root, runId),
        resume: async (runId) => await resumeRun(active, root, runId),
        deleteRun: async (runId) => {
          await historyStoreFor(root).delete(runId);
          cachedSnapshots.delete(runId);
          await refreshHistory(root);
        },
      });
      applications.set(root, { engine: active, application });
      return application;
    };

    const restoreForWorkspace = async (context: ExtensionContext): Promise<void> => {
      const workspace = await workspaceForNavigator(context.cwd);
      const workspaceRoot = workspace?.root ?? context.cwd;
      const lock = await acquireWorkspace(workspaceRoot);
      if (!lock) {
        const owner = await coordinatorFor(workspaceRoot).currentOwner();
        context.ui.notify(workspaceBusyMessage(owner), "warning");
        return;
      }
      let recoveredStatePersisted = false;
      try {
        await publicationStoreFor(workspaceRoot).recoverPending();
      } catch (error) {
        context.ui.notify(
          `Wiki publication recovery failed: ${errorMessage(error)}. Resolve the publish journal before resuming this run.`,
          "error",
        );
        await releaseWorkspace(workspaceRoot);
        return;
      }
      const recoverable = (await freshHistoryForWorkspace(workspaceRoot, currentEngine(context)))
        .filter((summary) => isRecoverableRunStatus(summary.status))
        .sort(compareRunRecency);
      if (recoverable.length > 1) {
        context.ui.notify(multipleRecoverableMessage(recoverable), "warning");
        await releaseWorkspace(workspaceRoot);
        return;
      }
      let candidate = latestSessionCandidate(context, workspaceRoot);
      if (recoverable[0] && candidate?.session?.runId !== recoverable[0].id) {
        const snapshot = await historyStoreFor(workspaceRoot).load(recoverable[0].id);
        if (snapshot) candidate = { session: createWikiRunSession(snapshot) };
      }
      if (!candidate) {
        await releaseWorkspace(workspaceRoot);
        return;
      }
      if (!candidate.session) {
        context.ui.notify(incompatibleRunMessage(candidate.detail), "warning");
        await releaseWorkspace(workspaceRoot);
        return;
      }
      const active = currentEngine(context);
      // Pointer → history store → engine.restore(snapshot). Never half-restore.
      let historySnapshot: WikiRunSnapshot | undefined;
      try {
        historySnapshot = await historyStoreFor(workspaceRoot).load(candidate.session.runId);
      } catch (error) {
        context.ui.notify(
          `Wiki run history could not be loaded for ${candidate.session.runId}: ${errorMessage(error)}. Start a new run with /wiki generate.`,
          "warning",
        );
        await releaseWorkspace(workspaceRoot);
        return;
      }
      if (!historySnapshot) {
        context.ui.notify(
          `Wiki run ${candidate.session.runId} has no durable history and was not restored. Start a new run with /wiki generate.`,
          "warning",
        );
        await releaseWorkspace(workspaceRoot);
        return;
      }
      await coordinatorFor(workspaceRoot).updateRun(lock, historySnapshot.id);
      const snapshot = active.restore(historySnapshot);
      if (!snapshot) {
        const reasons = explainWikiRunSnapshot(historySnapshot);
        const detail = reasons.length > 0 ? reasons.join("; ") : "restore rejected snapshot";
        context.ui.notify(incompatibleRunMessage(detail), "warning");
        await releaseWorkspace(workspaceRoot);
        return;
      }
      // Optional durable integrity: missing research/synthesis/review handoffs block resume.
      let restored = snapshot;
      try {
        const problems = await active.applyRestoredArtifactHealth();
        if (problems.length > 0) {
          restored = active.getSnapshot() ?? snapshot;
          context.ui.notify(
            `Wiki run restored but is blocked: missing or unreadable handoff artifacts (${problems.length}). Retry the affected node or start a new run with /wiki generate.`,
            "warning",
          );
        }
      } catch {
        // Health check is best-effort; leave paused if the store is unavailable.
      }
      rememberSnapshot(restored);
      // Persist recovered state (running→paused) so history matches the restored engine.
      try {
        await checkpointFor(workspaceRoot).restoreCheckpoint(restored);
        historyWriteFailures.delete(path.resolve(workspaceRoot));
        recoveredStatePersisted = true;
      } catch (error) {
        reportHistoryFailure(workspaceRoot, error);
      } finally {
        // Session start never schedules agents; restored state is paused or terminal.
        if (recoveredStatePersisted && active.getSnapshot()?.status !== "running") {
          await releaseWorkspace(workspaceRoot);
        }
      }
    };

    pi.on("session_start", async (_event, context) => {
      persistenceErrorReporter = (message) => context.ui.notify(message, "error");
      bindEngine(context);
      await restoreForWorkspace(context);
      host?.unbind({ clearRetention: true });
      host = undefined;
      // Bind panel/status for the session. openNavigator rebinds with a fresh controller.
      await bindHost(context);
    });

    pi.on("session_shutdown", async () => {
      host?.unbind({ clearRetention: true });
      host = undefined;
      try {
        if (engine) {
          await engine.interrupt();
          await engine.waitForIdle();
          await persistNow();
        } else {
          await Promise.all([...checkpoints.values()].map(async (checkpoint) => await checkpoint.flush()));
        }
      } finally {
        await Promise.all([...applications.values()].map(async ({ application }) => await application.shutdown()));
        applications.clear();
        await releaseAllWorkspaces();
      }
      unsubscribeEngine?.();
      unsubscribeEngine = undefined;
      engine = undefined;
      persistenceErrorReporter = undefined;
    });

    async function bindHost(context: ExtensionContext): Promise<void> {
      const active = currentEngine(context);
      const workspace = await workspaceForNavigator(context.cwd);
      const historyRoot = workspace?.root ?? active.getSnapshot()?.cwd ?? context.cwd;
      await historyForWorkspace(historyRoot, active);
      host ??= createWikiUiHost();
      host.bind({
        engine: active,
        ui: context.ui,
        pi,
        language: workspace?.language ?? active.getSnapshot()?.language,
        mode: context.mode,
        getController: () => controller(active, workspace, historyRoot),
      });
    }

    pi.registerCommand("wiki", {
      description: "Set up, generate, and control a source-grounded Wiki workspace",
      getArgumentCompletions: wikiArgumentCompletions,
      async handler(rawArgs: string, context: ExtensionCommandContext): Promise<void> {
        let command: ParsedCommand;
        try {
          command = parseWikiCommand(rawArgs);
        } catch (error) {
          context.ui.notify(errorMessage(error), "warning");
          return;
        }

        switch (command.action) {
          case "init":
            await runWorkspaceOperation(context, "Initializing Wiki workspace", async () => await workspaceService.initialize({
              cwd: context.cwd,
              workspace: command.workspace,
              language: command.language,
            }));
            return;
          case "source-add":
            await runWorkspaceOperation(context, "Preparing Wiki source workspace", async () => await workspaceService.addSource({
              cwd: context.cwd,
              workspace: command.workspace,
              source: command.source,
            }));
            return;
          case "help":
            output(pi, context, helpText());
            return;
          case "open":
            await openOrPrint(context, currentEngine(context));
            return;
          case "status":
            output(pi, context, renderWikiRunText(currentEngine(context).getSnapshot()));
            return;
          case "history": {
            const workspace = await workspaceForNavigator(context.cwd);
            const root = workspace?.root ?? context.cwd;
            output(pi, context, renderWikiRunHistoryText(await historyForWorkspace(root, currentEngine(context))));
            return;
          }
          case "artifacts": {
            const active = currentEngine(context);
            const workspace = await workspaceForNavigator(context.cwd);
            const root = workspace?.root ?? context.cwd;
            const current = active.getSnapshot();
            const currentMatchesWorkspace = current && path.resolve(current.cwd) === path.resolve(root);
            const defaultRunId = currentMatchesWorkspace
              ? current.id
              : (await historyForWorkspace(root, active)).at(0)?.id;
            const runId = command.runId ?? defaultRunId;
            const snapshot = runId && current?.id === runId
              ? current
              : runId ? await historyStoreFor(root).load(runId) : undefined;
            output(pi, context, renderWikiArtifactText(snapshot));
            return;
          }
          case "generate":
          case "refresh": {
            try {
              const workspace = await workspaceService.load(context.cwd);
              const snapshot = await applicationFor(context, workspace.root).dispatch({ type: "start", request: {
                cwd: workspace.root,
                mode: command.action,
                language: command.language ?? workspace.language,
                focus: command.focus,
                maxResearchRounds: workspace.quality.maxResearchRounds,
                wikiPolicy: { ...workspace.wiki, quality: { maxSubmissionAttempts: workspace.quality.maxSubmissionAttempts } },
              } });
              if (!snapshot) throw new Error("Wiki run did not start");
              await ensureHost(context);
              host?.onRunStarted(snapshot);
              notifyRunStarted(context.ui, snapshot, command.language ?? workspace.language);
            } catch (error) {
              context.ui.notify(errorMessage(error), "error");
            }
            return;
          }
          case "pause":
            try {
              const workspace = await workspaceService.load(context.cwd);
              await applicationFor(context, workspace.root).dispatch({ type: "pause" });
              host?.refresh();
              context.ui.notify("Wiki scheduling paused; active agents may finish.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "warning");
            }
            return;
          case "resume":
            try {
              const workspace = await workspaceService.load(context.cwd);
              await applicationFor(context, workspace.root).dispatch({ type: "resume", runId: command.runId });
              host?.refresh();
              context.ui.notify("Wiki scheduling resumed after Git re-inspection.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "error");
            }
            return;
          case "stop":
            try {
              const workspace = await workspaceService.load(context.cwd);
              await applicationFor(context, workspace.root).dispatch({ type: "stop" });
              host?.refresh();
              context.ui.notify("Wiki agents aborted; run paused. Use /wiki resume to continue.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "warning");
            }
            return;
          case "cancel":
            try {
              const workspace = await workspaceService.load(context.cwd);
              await applicationFor(context, workspace.root).dispatch({ type: "cancel", runId: command.runId });
              host?.refresh();
              context.ui.notify("Wiki run cancelled.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "warning");
            }
        }
      },
    });

    async function ensureHost(context: ExtensionCommandContext | ExtensionContext): Promise<WikiUiHost> {
      if (host) return host;
      await bindHost(context);
      return host!;
    }

    async function openOrPrint(context: ExtensionCommandContext, active: WikiWorkflowEngine): Promise<void> {
      if (!context.hasUI || context.mode !== "tui") {
        output(pi, context, renderWikiRunText(active.getSnapshot()));
        return;
      }
      const workspace = await workspaceForNavigator(context.cwd);
      const historyRoot = workspace?.root ?? active.getSnapshot()?.cwd ?? context.cwd;
      await historyForWorkspace(historyRoot, active);
      await ensureHost(context);
      // Rebind so open uses a controller closed over the latest workspace/history.
      host!.bind({
        engine: active,
        ui: context.ui,
        pi,
        language: workspace?.language ?? active.getSnapshot()?.language,
        mode: context.mode,
        getController: () => controller(active, workspace, historyRoot),
      });
      await host!.openNavigator(context);
    }

    function controller(
      active: WikiWorkflowEngine,
      workspace: WikiNavigatorWorkspace | undefined,
      historyRoot: string,
    ): WikiNavigatorController {
      return {
        listRuns: () => runsForWorkspace(historyRoot, active),
        observe: (runId) => {
          const current = active.getSnapshot();
          const snapshot = !runId || current?.id === runId ? current : cachedSnapshots.get(runId);
          return snapshot ? viewFor(snapshot, active) : undefined;
        },
        load: async (runId) => {
          const current = active.getSnapshot();
          if (current?.id === runId) return viewFor(current, active);
          await checkpointFor(historyRoot).flush();
          const snapshot = await historyStoreFor(historyRoot).load(runId);
          if (snapshot) rememberSnapshot(snapshot);
          return snapshot ? viewFor(snapshot, active) : undefined;
        },
        activeRunId: () => {
          const snapshot = active.getSnapshot();
          // Terminal snapshots stay in history, but do not own navigator landing or actions.
          if (!snapshot || !isActiveRunStatus(snapshot.status)) return undefined;
          return snapshot.id;
        },
        getWorkspace: () => workspace,
        subscribe(listener) {
          historyListeners.add(listener);
          const unsubscribe = active.subscribe(() => listener());
          return () => {
            historyListeners.delete(listener);
            unsubscribe();
          };
        },
        dispatch: async (intent) => {
          const snapshot = await applicationForCurrent(active, historyRoot).dispatch(intent);
          return snapshot ? viewFor(snapshot, active) : undefined;
        },
      };
    }

    function viewFor(snapshot: WikiRunSnapshot, active: WikiWorkflowEngine) {
      const current = active.getSnapshot();
      const isActive = current?.id === snapshot.id && isActiveRunStatus(current.status);
      const liveNodeIds = isActive
        ? snapshot.nodes.filter((node) => active.isNodeLive(node.id)).map((node) => node.id)
        : [];
      return projectWikiRunView(snapshot, { activeRunId: isActive ? snapshot.id : undefined, liveNodeIds });
    }

    function applicationForCurrent(active: WikiWorkflowEngine, workspaceRoot: string): WikiWorkflowApplication {
      if (engine !== active) throw new Error("Navigator is no longer bound to the active Wiki engine");
      return applicationForEngine(active, workspaceRoot);
    }

    function historyStoreFor(workspace: string): WikiRunHistoryStore {
      const root = path.resolve(workspace);
      let store = historyStores.get(root);
      if (!store) {
        store = options.createHistoryStore?.(root) ?? createWikiRunHistoryStore({ workspace: root });
        historyStores.set(root, store);
      }
      return store;
    }

    function publicationStoreFor(workspace: string): WikiPublicationStore {
      const root = path.resolve(workspace);
      let store = publicationStores.get(root);
      if (!store) {
        store = options.createPublicationStore?.(root) ?? createWikiPublicationStore({ workspace: root });
        publicationStores.set(root, store);
      }
      return store;
    }

    function coordinatorFor(workspace: string): WikiWorkspaceCoordinator {
      const root = path.resolve(workspace);
      let coordinator = workspaceCoordinators.get(root);
      if (!coordinator) {
        coordinator = options.createWorkspaceCoordinator?.(root) ?? createWikiWorkspaceCoordinator(root);
        workspaceCoordinators.set(root, coordinator);
      }
      return coordinator;
    }

    async function acquireWorkspace(workspace: string, runId?: string): Promise<WikiWorkspaceLock | undefined> {
      const root = path.resolve(workspace);
      const existing = workspaceLocks.get(root);
      if (existing) {
        if (!runId || !existing.owner.runId || existing.owner.runId !== runId) {
          const detail = existing.owner.runId ? ` for run ${existing.owner.runId}` : "";
          throw new Error(`Wiki workspace already has an active operation${detail}`);
        }
        return existing;
      }
      const lock = await coordinatorFor(root).acquire(runId);
      if (lock) workspaceLocks.set(root, lock);
      return lock;
    }

    async function requireWorkspace(workspace: string, runId?: string): Promise<WikiWorkspaceLock> {
      const lock = await acquireWorkspace(workspace, runId);
      if (lock) return lock;
      throw new Error(workspaceBusyMessage(await coordinatorFor(workspace).currentOwner()));
    }

    async function updateWorkspaceRun(workspace: string, runId: string): Promise<void> {
      const root = path.resolve(workspace);
      const lock = workspaceLocks.get(root);
      if (!lock) throw new Error("Wiki workspace ownership is required");
      await coordinatorFor(root).updateRun(lock, runId);
    }

    async function releaseWorkspace(workspace: string, runId?: string): Promise<void> {
      const root = path.resolve(workspace);
      const lock = workspaceLocks.get(root);
      if (!lock) return;
      if (runId && lock.owner.runId !== runId) return;
      await coordinatorFor(root).release(lock);
      workspaceLocks.delete(root);
    }

    async function releaseAllWorkspaces(): Promise<void> {
      for (const workspace of [...workspaceLocks.keys()]) await releaseWorkspace(workspace);
    }

    function rememberSnapshot(snapshot: WikiRunSnapshot): void {
      cachedSnapshots.set(snapshot.id, structuredClone(snapshot));
      const workspace = path.resolve(snapshot.cwd);
      const next = summarizeWikiRun(snapshot);
      const previous = historySummaries.get(workspace) ?? [];
      historySummaries.set(workspace, mergeRunSummary(previous, next));
    }

    /**
     * When the engine has no current run, bind the latest recoverable history
     * snapshot so pause/resume can act without a prior session restore.
     */
    async function bindLatestRecoverable(
      active: WikiWorkflowEngine,
      workspace: string,
    ): Promise<WikiRunSnapshot> {
      const root = path.resolve(workspace);
      await checkpointFor(root).flush();
      const candidates = (await freshHistoryForWorkspace(root, active))
        .filter((summary) => isRecoverableRunStatus(summary.status))
        .sort(compareRunRecency);
      if (candidates.length > 1) throw new Error(multipleRecoverableMessage(candidates));
      let snapshot: WikiRunSnapshot | undefined;
      for (const candidate of candidates) {
        snapshot = await historyStoreFor(root).load(candidate.id);
        if (snapshot) break;
      }
      if (!snapshot) throw new Error("No paused or interrupted Wiki run is available in this workspace");
      if (path.resolve(snapshot.cwd) !== root) {
        throw new Error(`Wiki run ${snapshot.id} belongs to a different workspace`);
      }
      const restored = active.restore(snapshot);
      if (!restored) {
        const reasons = explainWikiRunSnapshot(snapshot);
        const detail = reasons.length > 0 ? reasons.join("; ") : "restore rejected snapshot";
        throw new Error(incompatibleRunMessage(detail));
      }
      // Persist recovered state (running→paused) and its Pi pointer together.
      await checkpointFor(root).restoreCheckpoint(restored);
      await updateWorkspaceRun(root, restored.id);
      return restored;
    }

    async function bindRecoverableById(
      active: WikiWorkflowEngine,
      workspace: string,
      runId?: string,
    ): Promise<WikiRunSnapshot> {
      if (!runId) return await bindLatestRecoverable(active, workspace);
      const root = path.resolve(workspace);
      await checkpointFor(root).flush();
      const snapshot = await historyStoreFor(root).load(runId);
      if (!snapshot) throw new Error(`Wiki run ${runId} was not found in this workspace`);
      if (path.resolve(snapshot.cwd) !== root) throw new Error(`Wiki run ${runId} belongs to a different workspace`);
      if (!isRecoverableRunStatus(snapshot.status)) {
        throw new Error(`Wiki run ${runId} is ${snapshot.status} and cannot be cancelled as an active run`);
      }
      const restored = active.restore(snapshot);
      if (!restored) throw new Error(incompatibleRunMessage(explainWikiRunSnapshot(snapshot).join("; ")));
      await checkpointFor(root).restoreCheckpoint(restored);
      await updateWorkspaceRun(root, restored.id);
      return restored;
    }

    async function resumeRun(
      active: WikiWorkflowEngine,
      workspace: string,
      runId?: string,
    ): Promise<WikiRunSnapshot | undefined> {
      const root = path.resolve(workspace);
      const current = active.getSnapshot();

      if (current && (!runId || current.id === runId)) {
        assertResumable(current);
        await updateWorkspaceRun(root, current.id);
        {
          const workspace = await workspaceService.load(root);
          active.reconcilePolicy({ ...workspace.wiki, quality: { maxSubmissionAttempts: workspace.quality.maxSubmissionAttempts } });
        }
        return await active.resume();
      }
      if (current && isActiveRunStatus(current.status)) {
        throw new Error(`Wiki run ${current.id} is already active; pause, resume, or cancel it before restoring another run`);
      }

      await checkpointFor(root).flush();
      let snapshot: WikiRunSnapshot | undefined;
      if (runId) {
        snapshot = await historyStoreFor(root).load(runId);
        if (!snapshot) throw new Error(`Wiki run ${runId} was not found in this workspace`);
      } else {
        const candidates = (await freshHistoryForWorkspace(root, active))
          .filter((summary) => isRecoverableRunStatus(summary.status))
          .sort(compareRunRecency);
        for (const candidate of candidates) {
          snapshot = await historyStoreFor(root).load(candidate.id);
          if (snapshot) break;
        }
        if (!snapshot) throw new Error("No paused or interrupted Wiki run is available in this workspace");
      }

      if (path.resolve(snapshot.cwd) !== root) {
        throw new Error(`Wiki run ${snapshot.id} belongs to a different workspace`);
      }
      assertResumable(snapshot);
      const restored = active.restore(snapshot);
      if (!restored) {
        const reasons = explainWikiRunSnapshot(snapshot);
        const detail = reasons.length > 0 ? reasons.join("; ") : "restore rejected snapshot";
        throw new Error(incompatibleRunMessage(detail));
      }
      await updateWorkspaceRun(root, restored.id);
      {
        const workspace = await workspaceService.load(root);
        active.reconcilePolicy({ ...workspace.wiki, quality: { maxSubmissionAttempts: workspace.quality.maxSubmissionAttempts } });
      }
      // Persist recovered state and pointer before any executor can resume.
      await checkpointFor(root).restoreCheckpoint(restored);
      return await active.resume();
    }

    function assertResumable(snapshot: WikiRunSnapshot): void {
      if (isRecoverableRunStatus(snapshot.status)) return;
      if (snapshot.status === "failed" || snapshot.status === "blocked") {
        throw new Error(`Wiki run ${snapshot.id} requires a targeted node or phase retry`);
      }
      throw new Error(`Wiki run ${snapshot.id} is ${snapshot.status} and cannot be resumed`);
    }

    async function refreshHistory(workspace: string): Promise<WikiRunSummary[]> {
      const root = path.resolve(workspace);
      const summaries = await historyStoreFor(root).list();
      historySummaries.set(root, summaries);
      for (const listener of historyListeners) listener();
      return summaries;
    }

    async function historyForWorkspace(workspace: string, active: WikiWorkflowEngine): Promise<WikiRunSummary[]> {
      await checkpointFor(workspace).flush();
      await refreshHistory(workspace);
      return runsForWorkspace(workspace, active);
    }

    async function freshHistoryForWorkspace(workspace: string, active: WikiWorkflowEngine): Promise<WikiRunSummary[]> {
      const root = path.resolve(workspace);
      const summaries = await historyStoreFor(root).listFresh();
      historySummaries.set(root, summaries);
      return runsForWorkspace(root, active);
    }

    function runsForWorkspace(workspace: string, active: WikiWorkflowEngine): WikiRunSummary[] {
      const root = path.resolve(workspace);
      const summaries = historySummaries.get(root) ?? [];
      const current = active.getSnapshot();
      const currentSummary = current && path.resolve(current.cwd) === root ? summarizeWikiRun(current) : undefined;
      return currentSummary ? mergeRunSummary(summaries, currentSummary) : summaries.slice();
    }

    /**
     * Latest branch custom entry for this workspace. Returns a parseable pointer
     * session, or a detail string when the entry is present but incompatible
     * (legacy full-snapshot or malformed pointer — fail closed, no dual-read).
     */
    function latestSessionCandidate(
      context: ExtensionContext,
      workspaceRoot: string,
    ): { session: WikiRunSession; detail?: undefined } | { session?: undefined; detail: string } | undefined {
      const workspace = path.resolve(workspaceRoot);
      const entries = context.sessionManager.getBranch();
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type !== "custom" || entry.customType !== WIKI_RUN_CUSTOM_TYPE) continue;
        if (!isRecord(entry.data) || entry.data.customType !== WIKI_RUN_CUSTOM_TYPE || typeof entry.data.workspace !== "string") {
          continue;
        }
        if (!sameWorkspaceOrChild(path.resolve(entry.data.workspace), workspace)) continue;
        const session = parseWikiRunSession(entry.data);
        if (session) return { session };
        return { detail: describeIncompatibleSession(entry.data) };
      }
      return undefined;
    }

    async function runWorkspaceOperation(
      context: ExtensionCommandContext,
      message: string,
      operation: () => Promise<WikiWorkspaceResult>,
    ): Promise<void> {
      context.ui.setWorkingMessage(message);
      try {
        output(pi, context, workspaceText(await operation()));
      } catch (error) {
        context.ui.notify(errorMessage(error), "error");
      } finally {
        context.ui.setWorkingMessage();
      }
    }

    async function workspaceForNavigator(cwd: string): Promise<WikiNavigatorWorkspace | undefined> {
      try {
        const workspace = await workspaceService.load(cwd);
        return {
          root: workspace.root,
          language: workspace.language,
          sources: workspace.sources.map((source) => ({ path: source.path })),
        };
      } catch {
        return undefined;
      }
    }
  };
}

export default createWikiExtension();

function mergeRunSummary(existing: WikiRunSummary[], next: WikiRunSummary): WikiRunSummary[] {
  return [next, ...existing.filter((item) => item.id !== next.id)]
    .sort(compareRunRecency);
}

function compareRunRecency(left: Pick<WikiRunSummary, "id" | "updatedAt">, right: Pick<WikiRunSummary, "id" | "updatedAt">): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

function parseWikiCommand(raw: string): ParsedCommand {
  const values = tokenize(raw);
  const candidate = (values.shift() ?? "help").toLowerCase();
  if (candidate === "init") return parseInitCommand(values);
  if (candidate === "source") return parseSourceCommand(values);
  if (candidate === "artifacts") {
    if (values.length > 1) throw new Error("Usage: /wiki artifacts [runId]");
    const runId = values[0];
    if (runId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid Wiki run history identifier");
    return { action: "artifacts", runId };
  }
  if (!isWikiAction(candidate)) {
    throw new Error("Usage: /wiki init | source add | generate | refresh | open | status | history | artifacts");
  }
  const action = candidate;
  if (action === "resume" || action === "cancel") {
    if (values.length > 1) throw new Error(`Usage: /wiki ${action} [runId]`);
    const runId = values[0];
    if (runId && !isSafeRunId(runId)) throw new Error("Invalid Wiki run history identifier");
    return { action, runId };
  }
  if (action === "open" || action === "status" || action === "history" || action === "pause" || action === "stop" || action === "help") {
    if (values.length) throw new Error(`/wiki ${action} does not accept arguments`);
    return { action };
  }

  let language: "zh" | "en" | undefined;
  const focus: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value.startsWith("lang=")) {
      language = parseLanguage(value.slice("lang=".length));
      continue;
    }
    if (value === "--lang") {
      language = parseLanguage(values[++index] ?? "");
      continue;
    }
    focus.push(value);
  }
  return { action, language, focus: focus.join(" ").trim() || undefined };
}

function isWikiAction(value: string): value is ParsedRunCommand["action"] {
  return value === "open" || value === "generate" || value === "refresh" || value === "status" || value === "history"
    || value === "pause" || value === "resume" || value === "stop" || value === "cancel" || value === "help";
}

function parseInitCommand(values: string[]): Extract<ParsedCommand, { action: "init" }> {
  let workspace: string | undefined;
  let language: "zh" | "en" | undefined;
  while (values.length) {
    const option = values.shift();
    const value = values.shift();
    if (!value) throw new Error(`Missing value for ${option}`);
    if (option === "--workspace" && !workspace) {
      workspace = value;
      continue;
    }
    if ((option === "--lang" || option === "lang") && !language) {
      language = parseLanguage(value);
      continue;
    }
    throw new Error("Usage: /wiki init [--workspace <directory>] [--lang zh|en]");
  }
  return { action: "init", workspace, language };
}

function parseSourceCommand(values: string[]): Extract<ParsedCommand, { action: "source-add" }> {
  if (values.shift() !== "add") throw new Error("Usage: /wiki source add link <local-repository> [--workspace <directory>] | clone <git-url> [--ref <branch>] [--workspace <directory>]");
  const kind = values.shift();
  const target = values.shift();
  if ((kind !== "link" && kind !== "clone") || !target) {
    throw new Error("Usage: /wiki source add link <local-repository> [--workspace <directory>] | clone <git-url> [--ref <branch>] [--workspace <directory>]");
  }
  let workspace: string | undefined;
  let ref: string | undefined;
  while (values.length) {
    const option = values.shift();
    const value = values.shift();
    if (!value) throw new Error(`Missing value for ${option}`);
    if (option === "--workspace" && !workspace) {
      workspace = value;
      continue;
    }
    if (kind === "clone" && option === "--ref" && !ref) {
      ref = value;
      continue;
    }
    throw new Error("Usage: /wiki source add link <local-repository> [--workspace <directory>] | clone <git-url> [--ref <branch>] [--workspace <directory>]");
  }
  return kind === "link"
    ? { action: "source-add", workspace, source: { kind, path: target } }
    : { action: "source-add", workspace, source: { kind, url: target, ref } };
}

function tokenize(input: string): string[] {
  const values: string[] = [];
  for (const match of input.matchAll(/"([^\"]*)"|'([^']*)'|(\S+)/g)) values.push(match[1] ?? match[2] ?? match[3] ?? "");
  return values;
}

function parseLanguage(value: string): "zh" | "en" {
  if (value === "zh" || value === "en") return value;
  throw new Error("lang must be zh or en");
}

function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

const WIKI_COMMAND_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: "init ", label: "init", description: "Create or update workspace.yaml" },
  { value: "source ", label: "source", description: "Add a linked or cloned source repository" },
  { value: "generate ", label: "generate", description: "Generate the Wiki from all configured sources" },
  { value: "refresh ", label: "refresh", description: "Refresh Wiki pages affected by source changes" },
  { value: "open", label: "open", description: "Open the Wiki run Navigator" },
  { value: "status", label: "status", description: "Show the current run without opening the Navigator" },
  { value: "history", label: "history", description: "Show project Wiki run history" },
  { value: "artifacts ", label: "artifacts", description: "List persisted handoffs for a run" },
  { value: "pause", label: "pause", description: "Pause scheduling; active agents may finish" },
  { value: "resume ", label: "resume", description: "Resume the current, latest, or selected paused run" },
  { value: "stop", label: "stop", description: "Abort agents and pause (resumable)" },
  { value: "cancel", label: "cancel", description: "Cancel the active Wiki run (not resumable)" },
  { value: "help", label: "help", description: "Show all Wiki workspace commands" },
];

const LANGUAGE_COMPLETIONS = (prefix: string): AutocompleteItem[] => [
  { value: `${prefix}zh`, label: "zh", description: "Chinese Wiki" },
  { value: `${prefix}en`, label: "en", description: "English Wiki" },
];

/**
 * Pi exposes one slash-command namespace. Its argument completion API provides
 * the native, discoverable `/wiki <subcommand>` menu without registering a
 * second command system or relying on a CLI.
 */
export function wikiArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const input = argumentPrefix.trimStart();
  if (!input) return WIKI_COMMAND_COMPLETIONS.slice();

  const words = tokenize(input);
  const trailingSpace = /\s$/.test(input);
  const command = words[0]?.toLowerCase();
  if (!command) return WIKI_COMMAND_COMPLETIONS.slice();

  if (words.length === 1 && !trailingSpace) {
    return filterCompletions(WIKI_COMMAND_COMPLETIONS, command);
  }

  switch (command) {
    case "source":
      return sourceArgumentCompletions(words, trailingSpace);
    case "init":
      return initArgumentCompletions(input, words, trailingSpace);
    case "generate":
    case "refresh":
      return generationArgumentCompletions(words, trailingSpace);
    default:
      return null;
  }
}

function sourceArgumentCompletions(words: string[], trailingSpace: boolean): AutocompleteItem[] | null {
  if (words.length === 1 && trailingSpace) {
    return [{ value: "source add ", label: "add", description: "Register a source repository" }];
  }

  if (words.length === 2 && !trailingSpace) {
    return filterCompletions([
      { value: "source add ", label: "add", description: "Register a source repository" },
    ], words[1]);
  }

  if (words[1] !== "add") return null;
  if (words.length === 2 && trailingSpace) {
    return sourceKindCompletions("source add ");
  }
  if (words.length === 3 && !trailingSpace) {
    return filterCompletions(sourceKindCompletions("source add "), words[2]);
  }
  return null;
}

function sourceKindCompletions(prefix: string): AutocompleteItem[] {
  return [
    { value: `${prefix}link `, label: "link", description: "Link an existing local repository" },
    { value: `${prefix}clone `, label: "clone", description: "Clone a Git repository into the workspace" },
  ];
}

function initArgumentCompletions(input: string, words: string[], trailingSpace: boolean): AutocompleteItem[] | null {
  const last = words.at(-1);
  const beforeLast = words.at(-2);
  if (last === "--lang" && trailingSpace) return LANGUAGE_COMPLETIONS(input);
  if (last === "--workspace" && trailingSpace) return null;
  if (beforeLast === "--lang" && last && !trailingSpace) {
    return filterCompletions(LANGUAGE_COMPLETIONS(`${input.slice(0, input.length - last.length)}`), last);
  }
  if (beforeLast === "--workspace") return null;
  if (trailingSpace) return initOptionCompletions(input, words);
  return filterCompletions(initOptionCompletions(input.slice(0, input.length - (last?.length ?? 0)), words), last ?? "");
}

function initOptionCompletions(prefix: string, words: string[]): AutocompleteItem[] {
  const valuePrefix = `${prefix}${prefix.endsWith(" ") ? "" : " "}`;
  const options: AutocompleteItem[] = [];
  if (!words.includes("--lang")) {
    options.push({ value: `${valuePrefix}--lang `, label: "--lang", description: "Set the default Wiki language" });
  }
  if (!words.includes("--workspace")) {
    options.push({ value: `${valuePrefix}--workspace `, label: "--workspace", description: "Set the workspace directory" });
  }
  return options;
}

function generationArgumentCompletions(words: string[], trailingSpace: boolean): AutocompleteItem[] | null {
  const command = words[0];
  const last = words.at(-1);
  if (words.length === 1 && trailingSpace) return generationLanguageCompletions(`${command} `);
  if (words.length === 2 && !trailingSpace && last?.startsWith("lang=")) {
    return filterCompletions(generationLanguageCompletions(`${command} `), last);
  }
  return null;
}

function generationLanguageCompletions(prefix: string): AutocompleteItem[] {
  return [
    { value: `${prefix}lang=zh`, label: "lang=zh", description: "Generate in Chinese" },
    { value: `${prefix}lang=en`, label: "lang=en", description: "Generate in English" },
  ];
}

function filterCompletions(completions: readonly AutocompleteItem[], query: string): AutocompleteItem[] {
  const normalized = query.toLowerCase();
  return completions.filter((item) => item.label.toLowerCase().startsWith(normalized));
}

/**
 * Critical events force an immediate awaitable checkpoint. Only lifecycle,
 * node-terminal, recovered, and retry events qualify — not node_activity or
 * node_started (those stay debounced).
 */
function isCriticalEvent(event: WikiRunEvent): boolean {
  switch (event.kind) {
    case "run_started":
    case "run_paused":
    case "run_resumed":
    case "run_cancelled":
    case "run_completed":
    case "run_failed":
    case "run_blocked":
    case "run_forked":
    case "node_succeeded":
    case "node_failed":
    case "node_cancelled":
    case "node_retried":
    case "phase_retried":
    case "recovered":
      return true;
    default:
      return false;
  }
}

function incompatibleRunMessage(detail?: string): string {
  const suffix = detail ? ` (${detail})` : "";
  return `Wiki run is incompatible and was not restored${suffix}. Start a new run with /wiki generate; older session entries are not migrated.`;
}

function describeIncompatibleSession(data: Record<string, unknown>): string {
  if ("snapshot" in data) {
    const reasons = explainWikiRunSnapshot(data.snapshot);
    if (reasons.length > 0) return `legacy full-snapshot session; ${reasons.join("; ")}`;
    return "legacy full-snapshot session entry (pointer-only required)";
  }
  if (data.pointerVersion !== 1) {
    return `pointerVersion: expected 1, got ${String(data.pointerVersion)}`;
  }
  return "malformed session pointer";
}

function output(pi: ExtensionAPI, context: ExtensionCommandContext, content: string): void {
  if (context.hasUI && context.mode === "tui") {
    // Pi renders notifications with its wrapping Text component. Preserve the
    // structure of command help and run reports instead of flattening it.
    context.ui.notify(content, "info");
    return;
  }
  pi.sendMessage({ customType: "okf-wiki", content, display: true });
}

function helpText(): string {
  return [
    "Usage:",
    "  /wiki                  # show this help",
    "  /wiki open",
    "  /wiki generate [lang=zh|en] [focus]",
    "  /wiki refresh [lang=zh|en] [focus]",
    "  /wiki status | history | artifacts [runId] | pause | resume [runId] | stop | cancel",
    "  /wiki help",
    "  /wiki init [--workspace <directory>] [--lang zh|en]",
    "  /wiki source add link <local-repository> [--workspace <directory>]",
    "  /wiki source add clone <git-url> [--ref <branch>] [--workspace <directory>]",
  ].join("\n");
}

function workspaceText(result: WikiWorkspaceResult): string {
  const action = result.action === "initialized" ? "Initialized"
    : result.action === "linked" ? "Linked"
      : "Cloned";
  const source = result.sourcePath ? ` Source: ${result.sourcePath}.` : "";
  return `${action} Wiki workspace: ${result.workspace}. Language: ${result.language}.${source}`;
}

function sameWorkspaceOrChild(workspace: string, cwd: string): boolean {
  const relative = path.relative(workspace, cwd);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecoverableRunStatus(status: WikiRunSnapshot["status"]): boolean {
  return status === "running" || status === "paused";
}

function workspaceBusyMessage(owner: WikiWorkspaceOwner | undefined): string {
  if (!owner) return "Wiki workspace is locked by another Pi process";
  const run = owner.runId ? ` for run ${owner.runId}` : "";
  return `Wiki workspace is active in Pi process ${owner.pid}${run}; close that process before modifying this workspace. If that PID no longer exists and retries remain blocked, confirm no Pi process owns the workspace, then remove an orphaned .okf-wiki/active.reclaim file`;
}

function activeRunConflictMessage(runs: WikiRunSummary[]): string {
  const ids = runs.map((run) => run.id).join(", ");
  const selected = runs.length === 1 ? runs[0].id : "<runId>";
  return `Wiki workspace has recoverable run${runs.length === 1 ? "" : "s"} ${ids}; use /wiki resume ${selected} or /wiki cancel ${selected} before starting a new run`;
}

function multipleRecoverableMessage(runs: WikiRunSummary[]): string {
  return `Multiple recoverable Wiki runs require explicit selection: ${runs.map((run) => run.id).join(", ")}. Use /wiki resume <runId> or /wiki cancel <runId>.`;
}
