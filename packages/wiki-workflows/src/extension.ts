import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createPiAgentExecutor } from "./executor.js";
import { createWikiWorkflowEngine, type WikiWorkflowEngine } from "./engine.js";
import { createWikiUiHost, notifyRunStarted, type WikiUiHost } from "./ui/host.js";
import type { WikiNavigatorController, WikiNavigatorWorkspace } from "./ui/model.js";
import { renderWikiArtifactText, renderWikiRunHistoryText, renderWikiRunText } from "./ui/text.js";
import { createWikiRunHistoryStore, summarizeWikiRun, type WikiRunHistoryStore } from "./run-history.js";
import { parseWikiRunSession, WIKI_RUN_CUSTOM_TYPE } from "./session.js";
import type { WikiRunEvent, WikiRunSnapshot, WikiRunSummary } from "./workflow-types.js";
import { wikiWorkspaceService, type WikiWorkspaceResult, type WikiWorkspaceService } from "./workspace.js";
import { isExecutingRunStatus, isTerminalRunStatus } from "./ui/format.js";

const STATE_FLUSH_MS = 500;

export interface WikiExtensionOptions {
  createEngine?: (context: ExtensionContext) => WikiWorkflowEngine;
  workspaceService?: WikiWorkspaceService;
  /** Test seam for project-scoped durable Wiki run history. */
  createHistoryStore?: (workspace: string) => WikiRunHistoryStore;
}

interface ParsedRunCommand {
  action: "open" | "generate" | "refresh" | "status" | "history" | "pause" | "resume" | "cancel" | "help";
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
    let unsubscribeEngine: (() => void) | undefined;
    let host: WikiUiHost | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let historyWriteChain = Promise.resolve();
    let historyWriteFailure: unknown;
    let persistenceErrorReporter: ((message: string) => void) | undefined;
    const workspaceService = options.workspaceService ?? wikiWorkspaceService;
    const historyStores = new Map<string, WikiRunHistoryStore>();
    const historySummaries = new Map<string, WikiRunSummary[]>();
    const cachedSnapshots = new Map<string, WikiRunSnapshot>();
    const historyListeners = new Set<() => void>();

    const createEngine = (context: ExtensionContext): WikiWorkflowEngine => options.createEngine?.(context) ?? createWikiWorkflowEngine({
      executor: createPiAgentExecutor({
        getModel: () => context.model,
        getThinkingLevel: () => context.thinkingLevel,
      }),
    });

    const persistNow = async (): Promise<void> => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const session = engine?.serialize();
      if (!session) return;
      pi.appendEntry(WIKI_RUN_CUSTOM_TYPE, session);
      rememberSnapshot(session.snapshot);
      await enqueueHistorySave(session.snapshot);
    };

    const schedulePersist = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void persistNow();
      }, STATE_FLUSH_MS);
    };

    const bindEngine = (context: ExtensionContext): WikiWorkflowEngine => {
      unsubscribeEngine?.();
      engine = createEngine(context);
      unsubscribeEngine = engine.subscribe((snapshot, event) => {
        rememberSnapshot(snapshot);
        if (isCriticalEvent(event)) void persistNow();
        else schedulePersist();
      });
      return engine;
    };

    const currentEngine = (context: ExtensionContext): WikiWorkflowEngine => engine ?? bindEngine(context);

    const restoreForWorkspace = async (context: ExtensionContext): Promise<void> => {
      const workspace = await workspaceForNavigator(context.cwd);
      const restored = latestSessionState(context, workspace?.root ?? context.cwd);
      if (!restored) return;
      const snapshot = currentEngine(context).restore(restored);
      if (snapshot) {
        rememberSnapshot(snapshot);
        await enqueueHistorySave(snapshot);
      }
    };

    pi.on("session_start", async (_event, context) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
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
      if (engine) {
        await engine.interrupt();
        await engine.waitForIdle();
        await persistNow();
      } else {
        await historyWriteChain;
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
              const snapshot = currentEngine(context).start({
                cwd: workspace.root,
                mode: command.action,
                language: command.language ?? workspace.language,
                focus: command.focus,
                maxResearchRounds: workspace.quality.maxResearchRounds,
              });
              await persistNow();
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
              currentEngine(context).pause();
              await persistNow();
              host?.refresh();
              context.ui.notify("Wiki scheduling paused.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "warning");
            }
            return;
          case "resume":
            try {
              const workspace = await workspaceService.load(context.cwd);
              await resumeRun(currentEngine(context), workspace.root, command.runId);
              await persistNow();
              host?.refresh();
              context.ui.notify("Wiki scheduling resumed after Git re-inspection.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "error");
            }
            return;
          case "cancel":
            try {
              await currentEngine(context).cancel();
              await persistNow();
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
        getRun: (runId) => {
          const current = active.getSnapshot();
          if (!runId || current?.id === runId) return current;
          return cachedSnapshots.get(runId);
        },
        loadRun: async (runId) => {
          const current = active.getSnapshot();
          if (current?.id === runId) return current;
          await historyWriteChain;
          const snapshot = await historyStoreFor(historyRoot).load(runId);
          if (snapshot) rememberSnapshot(snapshot);
          return snapshot;
        },
        getActiveRunId: () => {
          const snapshot = active.getSnapshot();
          // Terminal snapshots stay in history, but do not own navigator landing or actions.
          if (!snapshot || !isExecutingRunStatus(snapshot.status)) return undefined;
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
        retryNode: async (runId, nodeId) => {
          const current = active.getSnapshot();
          const retryCurrent = current?.id === runId && current && isExecutingRunStatus(current.status);
          await historyWriteChain;
          const snapshot = current?.id === runId ? current : await historyStoreFor(historyRoot).load(runId);
          if (!snapshot) throw new Error("Wiki run history is unavailable");
          const retried = retryCurrent
            ? await active.retryNode(nodeId)
            : await active.forkAndRetryNode(snapshot, nodeId);
          await persistNow();
          return retried;
        },
        retryPhase: async (runId, phaseId) => {
          const current = active.getSnapshot();
          const retryCurrent = current?.id === runId && current && isExecutingRunStatus(current.status);
          await historyWriteChain;
          const snapshot = current?.id === runId ? current : await historyStoreFor(historyRoot).load(runId);
          if (!snapshot) throw new Error("Wiki run history is unavailable");
          const retried = retryCurrent
            ? await active.retryPhase(phaseId)
            : await active.forkAndRetryPhase(snapshot, phaseId);
          await persistNow();
          return retried;
        },
        deleteRun: async (runId) => {
          if (runId === active.getSnapshot()?.id) throw new Error("The active Wiki run cannot be deleted");
          await historyWriteChain;
          const snapshot = cachedSnapshots.get(runId) ?? await historyStoreFor(historyRoot).load(runId);
          if (!snapshot || !isTerminalRunStatus(snapshot.status)) throw new Error("Only completed Wiki history can be deleted");
          await historyStoreFor(historyRoot).delete(runId);
          cachedSnapshots.delete(runId);
          await refreshHistory(historyRoot);
        },
        pause: async () => {
          active.pause();
          await persistNow();
        },
        resume: async (runId) => {
          await resumeRun(active, historyRoot, runId);
          await persistNow();
        },
        cancel: async () => {
          await active.cancel();
          await persistNow();
        },
      };
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

    function rememberSnapshot(snapshot: WikiRunSnapshot): void {
      cachedSnapshots.set(snapshot.id, structuredClone(snapshot));
      const workspace = path.resolve(snapshot.cwd);
      const next = summarizeWikiRun(snapshot);
      const previous = historySummaries.get(workspace) ?? [];
      historySummaries.set(workspace, mergeRunSummary(previous, next));
    }

    function enqueueHistorySave(snapshot: WikiRunSnapshot): Promise<void> {
      const value = structuredClone(snapshot);
      const workspace = path.resolve(value.cwd);
      const operation = historyWriteChain.then(async () => {
        await historyStoreFor(workspace).save(value);
        await refreshHistory(workspace);
        historyWriteFailure = undefined;
      });
      historyWriteChain = operation.catch((error: unknown) => {
        const message = `Wiki run history could not be saved: ${errorMessage(error)}`;
        if (historyWriteFailure !== message) {
          console.warn(`[okf-wiki] ${message}`);
          persistenceErrorReporter?.(message);
        }
        historyWriteFailure = message;
      });
      return historyWriteChain;
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
        return await active.resume();
      }
      if (current && isExecutingRunStatus(current.status)) {
        throw new Error(`Wiki run ${current.id} is already active; pause, resume, or cancel it before restoring another run`);
      }

      await historyWriteChain;
      let snapshot: WikiRunSnapshot | undefined;
      if (runId) {
        snapshot = await historyStoreFor(root).load(runId);
        if (!snapshot) throw new Error(`Wiki run ${runId} was not found in this workspace`);
      } else {
        const candidates = (await historyForWorkspace(root, active))
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
      if (!restored) throw new Error(`Wiki run ${snapshot.id} could not be restored`);
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
      await historyWriteChain;
      await refreshHistory(workspace);
      return runsForWorkspace(workspace, active);
    }

    function runsForWorkspace(workspace: string, active: WikiWorkflowEngine): WikiRunSummary[] {
      const root = path.resolve(workspace);
      const summaries = historySummaries.get(root) ?? [];
      const current = active.getSnapshot();
      const currentSummary = current && path.resolve(current.cwd) === root ? summarizeWikiRun(current) : undefined;
      return currentSummary ? mergeRunSummary(summaries, currentSummary) : summaries.slice();
    }

    function latestSessionState(context: ExtensionContext, workspaceRoot: string) {
      const workspace = path.resolve(workspaceRoot);
      const entries = context.sessionManager.getBranch();
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type !== "custom" || entry.customType !== WIKI_RUN_CUSTOM_TYPE) continue;
        const session = parseWikiRunSession(entry.data);
        if (session && sameWorkspaceOrChild(path.resolve(session.workspace), workspace)) return session;
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
  if (action === "resume") {
    if (values.length > 1) throw new Error("Usage: /wiki resume [runId]");
    const runId = values[0];
    if (runId && !isSafeRunId(runId)) throw new Error("Invalid Wiki run history identifier");
    return { action, runId };
  }
  if (action === "open" || action === "status" || action === "history" || action === "pause" || action === "cancel" || action === "help") {
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
    || value === "pause" || value === "resume" || value === "cancel" || value === "help";
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
  { value: "pause", label: "pause", description: "Pause scheduling after active agents finish" },
  { value: "resume ", label: "resume", description: "Resume the current, latest, or selected paused run" },
  { value: "cancel", label: "cancel", description: "Cancel the active Wiki run" },
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

function isCriticalEvent(event: WikiRunEvent): boolean {
  return event.kind !== "node_activity";
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
    "  /wiki status | history | artifacts [runId] | pause | resume [runId] | cancel",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameWorkspaceOrChild(workspace: string, cwd: string): boolean {
  const relative = path.relative(workspace, cwd);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecoverableRunStatus(status: WikiRunSnapshot["status"]): boolean {
  return status === "running" || status === "paused";
}
