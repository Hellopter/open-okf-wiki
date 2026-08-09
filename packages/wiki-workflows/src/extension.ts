import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createPiAgentExecutor } from "./executor.js";
import { createWikiWorkflowEngine, type WikiWorkflowEngine } from "./engine.js";
import { openWikiRunNavigator, renderWikiRunText, type WikiNavigatorController, type WikiNavigatorWorkspace } from "./navigator.js";
import { parseWikiRunSession, WIKI_RUN_CUSTOM_TYPE } from "./session.js";
import type { WikiRunEvent, WikiRunSnapshot } from "./workflow-types.js";
import { wikiWorkspaceService, type WikiWorkspaceResult, type WikiWorkspaceService } from "./workspace.js";

const STATE_FLUSH_MS = 500;
const STATUS_KEY = "okf-wiki";

export interface WikiExtensionOptions {
  createEngine?: (context: ExtensionContext) => WikiWorkflowEngine;
  workspaceService?: WikiWorkspaceService;
}

interface ParsedRunCommand {
  action: "open" | "generate" | "refresh" | "status" | "pause" | "resume" | "cancel" | "help";
  focus?: string;
  language?: "zh" | "en";
}

type ParsedCommand = ParsedRunCommand
  | { action: "init"; workspace?: string; language?: "zh" | "en" }
  | { action: "source-add"; workspace?: string; source: { kind: "link"; path: string } | { kind: "clone"; url: string; ref?: string } };

/**
 * Pi extension entry point. The engine is intentionally Wiki-specific; generic
 * workflow state, saved commands, and a CLI are not installed.
 */
export function createWikiExtension(options: WikiExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    let engine: WikiWorkflowEngine | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const workspaceService = options.workspaceService ?? wikiWorkspaceService;

    const createEngine = (context: ExtensionContext): WikiWorkflowEngine => options.createEngine?.(context) ?? createWikiWorkflowEngine({
      executor: createPiAgentExecutor({
        getModel: () => context.model,
        getThinkingLevel: () => context.thinkingLevel,
      }),
    });

    const persistNow = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const session = engine?.serialize();
      if (!session) return;
      pi.appendEntry(WIKI_RUN_CUSTOM_TYPE, session);
    };

    const schedulePersist = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        persistNow();
      }, STATE_FLUSH_MS);
    };

    const bindEngine = (context: ExtensionContext): WikiWorkflowEngine => {
      engine = createEngine(context);
      engine.subscribe((snapshot, event) => {
        if (isCriticalEvent(event)) persistNow();
        else schedulePersist();
      });
      return engine;
    };

    const currentEngine = (context: ExtensionContext): WikiWorkflowEngine => engine ?? bindEngine(context);

    const restoreForWorkspace = (context: ExtensionContext): void => {
      const restored = latestSessionState(context);
      if (!restored) return;
      currentEngine(context).restore(restored);
    };

    pi.on("session_start", (_event, context) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      bindEngine(context);
      restoreForWorkspace(context);
    });

    pi.on("session_shutdown", async () => {
      if (!engine) return;
      await engine.interrupt();
      persistNow();
    });

    pi.registerCommand("wiki", {
      description: "Generate, refresh, inspect, and control the Git-native repository Wiki",
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
          case "generate":
          case "refresh": {
            try {
              const workspace = await workspaceService.load(context.cwd);
              const snapshot = currentEngine(context).start({
                cwd: workspace.root,
                mode: command.action,
                language: command.language ?? workspace.language,
                focus: command.focus,
              });
              persistNow();
              context.ui.notify(`Started ${snapshot.effectiveMode ?? snapshot.requestedMode} Wiki run.`, "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "error");
            }
            return;
          }
          case "pause":
            try {
              currentEngine(context).pause();
              persistNow();
              context.ui.notify("Wiki scheduling paused.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "warning");
            }
            return;
          case "resume":
            try {
              await currentEngine(context).resume();
              persistNow();
              context.ui.notify("Wiki scheduling resumed after Git re-inspection.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "error");
            }
            return;
          case "cancel":
            try {
              await currentEngine(context).cancel();
              persistNow();
              context.ui.notify("Wiki run cancelled.", "info");
            } catch (error) {
              context.ui.notify(errorMessage(error), "warning");
            }
        }
      },
    });

    async function openOrPrint(context: ExtensionCommandContext, active: WikiWorkflowEngine): Promise<void> {
      if (!context.hasUI || context.mode !== "tui") {
        output(pi, context, renderWikiRunText(active.getSnapshot()));
        return;
      }
      const workspace = await workspaceForNavigator(context.cwd);
      const unsubscribeStatus = active.subscribe((snapshot) => {
        context.ui.setStatus(STATUS_KEY, statusText(snapshot));
      });
      context.ui.setStatus(STATUS_KEY, statusText(active.getSnapshot()));
      try {
        await openWikiRunNavigator(context.ui, controller(active, workspace));
      } finally {
        unsubscribeStatus();
        context.ui.setStatus(STATUS_KEY, undefined);
      }
    }

    function controller(active: WikiWorkflowEngine, workspace: WikiNavigatorWorkspace | undefined): WikiNavigatorController {
      return {
        getRun: () => active.getSnapshot(),
        getWorkspace: () => workspace,
        subscribe(listener) {
          return active.subscribe(() => listener());
        },
        retryNode: async (nodeId) => {
          await active.retryNode(nodeId);
          persistNow();
        },
        pause: () => {
          active.pause();
          persistNow();
        },
        resume: async () => {
          await active.resume();
          persistNow();
        },
        cancel: async () => {
          await active.cancel();
          persistNow();
        },
      };
    }

    function latestSessionState(context: ExtensionContext) {
      const workspace = path.resolve(context.cwd);
      const entries = context.sessionManager.getEntries();
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

function parseWikiCommand(raw: string): ParsedCommand {
  const values = tokenize(raw);
  const candidate = (values.shift() ?? "status").toLowerCase();
  if (candidate === "init") return parseInitCommand(values);
  if (candidate === "source") return parseSourceCommand(values);
  if (!isWikiAction(candidate)) {
    throw new Error("Usage: /wiki init | source add | generate | refresh | open | status");
  }
  const action = candidate;
  if (action === "open" || action === "status" || action === "pause" || action === "resume" || action === "cancel" || action === "help") {
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
  return value === "open" || value === "generate" || value === "refresh" || value === "status"
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

function isCriticalEvent(event: WikiRunEvent): boolean {
  return event.kind !== "node_activity";
}

function statusText(snapshot: WikiRunSnapshot | undefined): string {
  if (!snapshot) return "Wiki: no run";
  const active = snapshot.nodes.filter((node) => node.status === "running").length;
  const failed = snapshot.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length;
  return `Wiki ${snapshot.status} | ${active} running${failed ? ` | ${failed} failed` : ""}`;
}

function output(pi: ExtensionAPI, context: ExtensionCommandContext, content: string): void {
  if (context.hasUI && context.mode === "tui") {
    context.ui.notify(content.replace(/\s*\n\s*/g, " "), "info");
    return;
  }
  pi.sendMessage({ customType: "okf-wiki", content, display: true });
}

function helpText(): string {
  return [
    "Usage:",
    "  /wiki                  # non-blocking status",
    "  /wiki open",
    "  /wiki generate [lang=zh|en] [focus]",
    "  /wiki refresh [lang=zh|en] [focus]",
    "  /wiki status | pause | resume | cancel",
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
