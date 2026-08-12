import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseWikiCliCommand,
  renderWikiEvent,
  renderWikiRun,
  renderWikiRuns,
  wikiCliHelp,
  type WikiCliCommand,
} from "./cli.js";
import { createConfiguredWikiProducer } from "./production.js";
import type { WikiProducer } from "./producer.js";
import type { WikiRunHandle, WikiRunView } from "./producer-types.js";
import { errorMessage } from "./util.js";
import { loadWikiWorkspace, wikiWorkspaceManagement, type ResolvedWikiWorkspace } from "./workspace.js";

export interface WikiExtensionOptions {
  createProducer?: (context: ExtensionContext) => WikiProducer;
}

export function createWikiExtension(options: WikiExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    let context: ExtensionContext | undefined;
    let producer: WikiProducer | undefined;

    const currentProducer = (active: ExtensionContext): WikiProducer => {
      context = active;
      producer ??= options.createProducer?.(active) ?? createConfiguredWikiProducer({
        getModel: () => context?.model,
        getThinkingLevel: () => context?.thinkingLevel,
      });
      return producer;
    };

    pi.on("session_start", async (_event, active) => {
      context = active;
      currentProducer(active);
    });

    pi.on("session_shutdown", async () => {
      if (producer && context) {
        try {
          const cwd = await workspaceRoot(context.cwd);
          const active = (await producer.list(cwd)).find((run) => run.status === "running");
          if (active) await (await producer.open(active.id, cwd))?.control("pause");
        } catch {
          // The durable ledger recovers an interrupted running process as paused.
        }
      }
      producer = undefined;
      context = undefined;
    });

    pi.registerCommand("wiki", {
      description: "Build, inspect, and control the repository Wiki",
      getArgumentCompletions: wikiArgumentCompletions,
      async handler(rawArgs: string, active: ExtensionCommandContext): Promise<void> {
        let command: WikiCliCommand;
        try {
          command = parseWikiCliCommand(rawArgs);
        } catch (error) {
          output(pi, active, `${errorMessage(error)}\n\n${wikiCliHelp()}`);
          return;
        }
        try {
          if (command.action === "init" || command.action === "source-add") {
            await dispatchWorkspace(pi, active, command);
            return;
          }
          const cwd = await workspaceRoot(active.cwd);
          const engine = currentProducer(active);
          await dispatch(pi, active, engine, cwd, command);
        } catch (error) {
          active.ui.notify(errorMessage(error), "error");
        }
      },
    });
  };
}

export default createWikiExtension();

async function dispatch(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  producer: WikiProducer,
  cwd: string,
  command: Exclude<WikiCliCommand, { action: "init" | "source-add" }>,
): Promise<void> {
  if (command.action === "run") {
    const handle = await producer.start({
      cwd,
      operation: command.regenerate ? "regenerate" : "update",
      focus: command.focus,
    });
    output(pi, context, renderWikiRun(await handle.view()));
    void streamRun(pi, context, handle);
    return;
  }
  if (command.action === "runs") {
    output(pi, context, renderWikiRuns(await producer.list(cwd)));
    return;
  }
  const handle = await selectedRun(producer, cwd, "runId" in command ? command.runId : undefined);
  if (command.action === "status") {
    output(pi, context, renderWikiRun(handle ? await handle.view() : undefined));
    return;
  }
  if (!handle) throw new Error("No Wiki run is available");
  const view = await handle.control(command.action);
  output(pi, context, renderWikiRun(view));
  if (command.action === "resume") {
    void streamRun(pi, context, handle, view.lastEventSequence);
  }
}

async function dispatchWorkspace(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  command: Extract<WikiCliCommand, { action: "init" | "source-add" }>,
): Promise<void> {
  if (command.action === "init") {
    const workspace = await wikiWorkspaceManagement.init({
      cwd: context.cwd,
      workspace: command.workspace,
      language: command.language,
      defaultSourceIgnores: command.defaultSourceIgnores,
      wikiExclude: command.exclude,
    });
    output(pi, context, `Wiki workspace initialized: ${workspace.root}\nLanguage: ${workspace.language}`);
    return;
  }
  const workspace = command.kind === "link"
    ? await wikiWorkspaceManagement.addLink({
      cwd: context.cwd,
      workspace: command.workspace,
      localPath: command.localPath,
      name: command.name,
    })
    : await wikiWorkspaceManagement.addClone({
      cwd: context.cwd,
      workspace: command.workspace,
      remoteUrl: command.url,
      ref: command.ref,
      name: command.name,
    });
  output(pi, context, renderAddedSource(workspace));
}

function renderAddedSource(workspace: ResolvedWikiWorkspace): string {
  const source = workspace.sources.at(-1);
  return source
    ? `Wiki source added: ${source.path}\nWorkspace: ${workspace.root}\nMode: ${source.origin.type}`
    : `Wiki workspace updated: ${workspace.root}`;
}

async function selectedRun(producer: WikiProducer, cwd: string, runId?: string): Promise<WikiRunHandle | undefined> {
  const runs = runId ? [] : await producer.list(cwd);
  const selected = runId ?? runs.find((run) => run.status === "running" || run.status === "paused")?.id ?? runs[0]?.id;
  return selected ? await producer.open(selected, cwd) : undefined;
}

async function streamRun(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  handle: WikiRunHandle,
  after = 0,
): Promise<void> {
  try {
    for await (const event of handle.events(after)) output(pi, context, renderWikiEvent(event));
  } catch (error) {
    context.ui.notify(`Wiki progress stream stopped: ${errorMessage(error)}`, "warning");
  }
}

async function workspaceRoot(cwd: string): Promise<string> {
  return (await loadWikiWorkspace(cwd)).root;
}

function output(pi: ExtensionAPI, context: ExtensionCommandContext, content: string): void {
  if (context.hasUI) context.ui.notify(content, "info");
  else void pi.sendMessage({ customType: "okf-wiki", content, display: true });
}

const COMPLETIONS = [
  { value: "init ", label: "init", description: "Initialize a Wiki workspace" },
  { value: "source add ", label: "source", description: "Link or clone a Git source" },
  { value: "regenerate ", label: "regenerate", description: "Rebuild the Wiki topology" },
  { value: "status ", label: "status", description: "Show a run" },
  { value: "runs", label: "runs", description: "List repository Wiki runs" },
  { value: "pause", label: "pause", description: "Pause the active run" },
  { value: "resume ", label: "resume", description: "Resume a paused run" },
  { value: "cancel ", label: "cancel", description: "Cancel a run" },
];

export function wikiArgumentCompletions(argumentPrefix: string) {
  const value = argumentPrefix.trimStart();
  if (!value) return COMPLETIONS.slice();
  if (/^source\s*$/.test(value)) {
    return [{ value: "source add ", label: "add", description: "Add a Git source" }];
  }
  if (/^source\s+add\s*$/.test(value)) {
    return [
      { value: "source add link ", label: "link", description: "Link a local Git repository root" },
      { value: "source add clone ", label: "clone", description: "Clone a Git URL" },
    ];
  }
  if (/\s/.test(value)) return null;
  return COMPLETIONS.filter((item) => item.label.startsWith(value));
}
