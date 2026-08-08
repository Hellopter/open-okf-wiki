import { resolve } from "node:path";
import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatWikiHelp,
  getWikiArgumentCompletions,
  parseWikiCommand,
  WIKI_COMMAND_USAGE,
  WikiCommandError,
  type WikiCommand,
} from "./command.js";
import { createWikiCore } from "@okf-wiki/wiki-agent-kit";
import type { WikiCore, WikiWorkspaceStatus } from "./core.js";
import {
  formatStatusBar,
  openWikiNavigator,
} from "./observe/index.js";
import {
  createSessionOrchestrator,
  DEFAULT_ORCH_LIMITS,
  type WikiOrchestrator,
  type WikiProgressSnapshot,
} from "./orch/index.js";
import { createWikiToolset, type WikiToolRole } from "./toolset.js";
import { WIKI_RUNTIME_DEFINITION } from "./runtime.js";

export type DisposableOrchestrator = WikiOrchestrator & { dispose?: () => Promise<void> };

export interface WikiExtensionOptions {
  core: WikiCore;
  /** Inject orchestrator (tests). Defaults to SessionWikiOrchestrator. */
  orchestratorFactory?: (options: {
    workspaceRoot: string;
    core: WikiCore;
    getMainModel: () => string | undefined;
    getModelRegistry: () => unknown;
  }) => DisposableOrchestrator;
}

const STATUS_KEY = "okf-wiki";
const CONTROL_TOOL_NAME = "okf_wiki";
const OBSERVE_OPTS = { staleWarnMs: DEFAULT_ORCH_LIMITS.staleWarnMs };

const CAPABILITY_NOTICE =
  "OKF Wiki (@okf-wiki/pi-wiki-agent) is loaded: source-grounded repository Wiki production. " +
  "Use /wiki generate to create a Markdown plan and OKF bundle; /wiki approve resumes proposed runs. " +
  "The main agent keeps a run-scoped persisted session. Open /wiki to observe phases and execution streams.";

type StatusUi = {
  setStatus: (key: string, text: string | undefined) => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
};

function projectSource(root: string): { type: "path"; id: "project"; path: string; ignore: ["sources/**"] } {
  return { type: "path", id: "project", path: root, ignore: ["sources/**"] };
}

function formatSourceList(status: WikiWorkspaceStatus): string {
  if (status.sources.length === 0) return "No sources registered.";
  return status.sources.map((source) => `- ${source.id} (${source.kind}): ${source.root ?? source.url ?? ""}`).join("\n");
}

function mainModelSpec(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  if (!model?.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function output(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "okf-wiki", content, display: true });
}

function formatWorkspaceStatus(status: WikiWorkspaceStatus): string {
  const lines: string[] = [];
  lines.push(`Wiki workspace: ${status.root}`);
  if (status.name) lines.push(`Name: ${status.name}`);
  if (status.wikiLanguage) lines.push(`Language: ${status.wikiLanguage}`);
  if (status.runtime) lines.push(`Runtime: ${status.runtime}`);

  lines.push("");
  lines.push("Sources:");
  lines.push(formatSourceList(status));

  lines.push("");
  lines.push("Domain runs:");
  if (status.active?.runId || status.activeRunId) {
    const id = status.active?.runId ?? status.activeRunId;
    const st = status.active?.status ? ` [${status.active.status}]` : "";
    lines.push(`- active: ${id}${st}`);
  } else {
    lines.push("- active: none");
  }
  if (status.runs && status.runs.length > 0) {
    for (const run of status.runs.slice(0, 10)) {
      const marker = run.runId === (status.active?.runId ?? status.activeRunId) ? " (current)" : "";
      lines.push(`- ${run.runId}${run.status ? ` [${run.status}]` : ""}${marker}`);
    }
  }

  return lines.join("\n");
}

async function readWorkspaceStatus(core: WikiCore, root: string): Promise<WikiWorkspaceStatus | undefined> {
  try {
    return await core.getWorkspaceStatus(root);
  } catch {
    return undefined;
  }
}

function applyObservationUi(ui: StatusUi, snap: WikiProgressSnapshot | undefined, workspace?: WikiWorkspaceStatus): void {
  if (snap) {
    ui.setStatus(STATUS_KEY, formatStatusBar(snap, OBSERVE_OPTS));
    return;
  }
  if (workspace) {
    const n = workspace.sources.length;
    ui.setStatus(STATUS_KEY, `Wiki: ${n} source${n === 1 ? "" : "s"}; no active orch run.`);
  } else {
    ui.setStatus(STATUS_KEY, "Wiki not initialized. Run /wiki init or /wiki help.");
  }
}

async function refreshObservation(
  core: WikiCore,
  orch: WikiOrchestrator,
  root: string,
  ui: StatusUi,
): Promise<void> {
  try {
    orch.syncFromBackend();
    let workspace: WikiWorkspaceStatus | undefined;
    try {
      workspace = await readWorkspaceStatus(core, root);
    } catch {
      workspace = undefined;
    }
    applyObservationUi(ui, orch.getActiveSnapshot(), workspace);
  } catch {
    // never fail session
  }
}

const NO_WORKSPACE_HINT = "No Wiki workspace. Run /wiki init.";

async function ensureWorkspace(
  core: WikiCore,
  root: string,
  options: { linkProjectOnCreate?: boolean } = {},
): Promise<WikiWorkspaceStatus> {
  try {
    return await core.getWorkspaceStatus(root);
  } catch {
    const initialized = await core.initializeWorkspace(root, {
      runtime: WIKI_RUNTIME_DEFINITION,
      ...(options.linkProjectOnCreate ? { source: projectSource(root) } : {}),
    });
    return initialized.workspace;
  }
}

async function openNavigator(
  core: WikiCore,
  orch: WikiOrchestrator,
  root: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  orch.syncFromBackend();
  const workspace = await readWorkspaceStatus(core, root);
  if (!workspace) throw new WikiCommandError(NO_WORKSPACE_HINT);
  await openWikiNavigator(
    { hasUI: ctx.hasUI, ui: ctx.ui },
    {
      getSnapshot: () => {
        orch.syncFromBackend();
        return orch.getActiveSnapshot();
      },
      idle: {
        initialized: workspace.initialized,
        root: workspace.root,
        name: workspace.name,
        sourceCount: workspace.sources.length,
      },
      subscribe: (cb) => orch.subscribe((snapshot) => cb(snapshot)),
      getTranscript: async (agentId) => await orch.getTranscript(agentId, { tail: 120 }),
      onPause: () => orch.pause(),
      onResume: () => orch.resume(),
      onStop: () => orch.stop(),
      onApprove: async () => {
        try {
          await orch.start({ workspaceRoot: workspace.root, action: "approve" });
          ctx.ui.notify("Approved Wiki plan. Continuing the active run.", "info");
          return true;
        } catch {
          return false;
        }
      },
      onReject: async () => {
        const stopped = await orch.stop();
        if (stopped) ctx.ui.notify("Rejected Wiki plan and stopped the active run.", "info");
        return stopped;
      },
      formatOpts: OBSERVE_OPTS,
    },
  );
}

async function executeCommand(
  pi: ExtensionAPI,
  core: WikiCore,
  orch: WikiOrchestrator,
  root: string,
  command: WikiCommand,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (command.action === "open") {
    await openNavigator(core, orch, root, ctx);
    await refreshObservation(core, orch, root, ctx.ui);
    return;
  }

  if (command.action === "help") {
    output(pi, formatWikiHelp());
    return;
  }

  if (command.action === "init") {
    const initialized = await core.initializeWorkspace(root, {
      name: command.name,
      wikiLanguage: command.wikiLanguage,
      force: command.force,
      runtime: WIKI_RUNTIME_DEFINITION,
      source: projectSource(root),
    });
    ctx.ui.notify(`Wiki initialized at ${initialized.workspace.root}`, "info");
    await refreshObservation(core, orch, root, ctx.ui);
    return;
  }

  if (command.action === "status") {
    orch.syncFromBackend();
    const status = await readWorkspaceStatus(core, root);
    const snap = orch.getActiveSnapshot();
    output(pi, JSON.stringify({ workspace: status, orchestration: snap ?? null, orchRuns: orch.list() }, null, 2));
    await refreshObservation(core, orch, root, ctx.ui);
    return;
  }

  if (command.action === "source-list") {
    const workspace = await readWorkspaceStatus(core, root);
    if (!workspace) {
      output(pi, NO_WORKSPACE_HINT);
      await refreshObservation(core, orch, root, ctx.ui);
      return;
    }
    output(pi, formatSourceList(workspace));
    return;
  }

  if (command.action === "pause") {
    const ok = await orch.pause(command.workflowRunId);
    if (!ok) throw new WikiCommandError("No active orchestration run to pause (or pause failed).");
    ctx.ui.notify("Paused wiki orchestration run.", "info");
    await refreshObservation(core, orch, root, ctx.ui);
    return;
  }
  if (command.action === "resume") {
    const ok = await orch.resume(command.workflowRunId);
    if (!ok) throw new WikiCommandError("No paused orchestration run to resume (or resume failed).");
    ctx.ui.notify("Resumed wiki orchestration run.", "info");
    await refreshObservation(core, orch, root, ctx.ui);
    return;
  }
  if (command.action === "stop") {
    const ok = await orch.stop(command.workflowRunId);
    if (!ok) throw new WikiCommandError("No active orchestration run to stop (or stop failed).");
    ctx.ui.notify("Stopped wiki orchestration run.", "info");
    await refreshObservation(core, orch, root, ctx.ui);
    return;
  }

  if (command.action === "source-remove") {
    if (!(await readWorkspaceStatus(core, root))) throw new WikiCommandError(NO_WORKSPACE_HINT);
    await core.removeSource(root, command.sourceId);
    ctx.ui.notify(`Removed source ${command.sourceId}.`, "info");
    await refreshObservation(core, orch, root, ctx.ui);
    return;
  }

  const workspace = await ensureWorkspace(core, root, { linkProjectOnCreate: true });
  switch (command.action) {
    case "source-add-clone": {
      const source = await core.addClonedSource(root, command);
      ctx.ui.notify(`Added cloned source ${source.id}.`, "info");
      await refreshObservation(core, orch, root, ctx.ui);
      return;
    }
    case "source-add-link": {
      const source = await core.addLinkedSource(root, { ...command, path: resolve(root, command.path) });
      ctx.ui.notify(`Added linked source ${source.id}.`, "info");
      await refreshObservation(core, orch, root, ctx.ui);
      return;
    }
    case "generate": {
      const started = await orch.start({
        workspaceRoot: workspace.root,
        action: "generate",
        focus: command.focus,
      });
      ctx.ui.notify(
        `Started wiki orchestration ${started.orchestrationId}` +
          (started.runId ? ` (run ${started.runId})` : "") +
          ". Open /wiki to observe.",
        "info",
      );
      await refreshObservation(core, orch, root, ctx.ui);
      return;
    }
    case "approve": {
      const started = await orch.start({ workspaceRoot: workspace.root, action: "approve", runId: command.runId });
      ctx.ui.notify(`Approved and resumed Wiki run ${started.runId ?? command.runId ?? ""}. Open /wiki to observe.`, "info");
      await refreshObservation(core, orch, root, ctx.ui);
      return;
    }
  }
}

function createControlTool(pi: ExtensionAPI, core: WikiCore, getOrch: () => WikiOrchestrator) {
  return defineTool({
    name: CONTROL_TOOL_NAME,
    label: "OKF Wiki",
    description:
      "Start or inspect the Markdown-first OKF repository Wiki workflow. Prefer /wiki for interactive control.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("generate"),
        Type.Literal("approve"),
        Type.Literal("status"),
        Type.Literal("stop"),
        Type.Literal("pause"),
        Type.Literal("resume"),
      ]),
      runId: Type.Optional(Type.String()),
      focus: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = resolve(ctx.cwd);
      const orch = getOrch();
      if (params.action === "status") {
        orch.syncFromBackend();
        const status = await readWorkspaceStatus(core, root);
        const snap = orch.getActiveSnapshot();
        return {
          content: [{ type: "text", text: status ? formatWorkspaceStatus(status) : NO_WORKSPACE_HINT }],
          details: { workspace: status, orchestration: snap ?? null },
        };
      }
      if (params.action === "stop") {
        const ok = await orch.stop();
        return { content: [{ type: "text", text: ok ? "Stopped." : "Nothing to stop." }], details: { ok } };
      }
      if (params.action === "pause") {
        const ok = await orch.pause();
        return { content: [{ type: "text", text: ok ? "Paused." : "Nothing to pause." }], details: { ok } };
      }
      if (params.action === "resume") {
        const ok = await orch.resume();
        return { content: [{ type: "text", text: ok ? "Resumed." : "Nothing to resume." }], details: { ok } };
      }
      const workspace = await ensureWorkspace(core, root, { linkProjectOnCreate: true });
      const started = await orch.start({
        workspaceRoot: workspace.root,
        action: params.action,
        runId: params.runId,
        focus: params.focus,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started wiki orchestration ${started.orchestrationId}. Open /wiki to observe.`,
          },
        ],
        details: { orchestrationId: started.orchestrationId, runId: started.runId, workspaceRoot: workspace.root },
      };
    },
  });
}

function ensureControlToolActive(pi: ExtensionAPI): void {
  try {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const active = pi.getActiveTools();
    if (!active.includes(CONTROL_TOOL_NAME)) {
      pi.setActiveTools([...active, CONTROL_TOOL_NAME]);
    }
  } catch {
    // optional
  }
}

/** Register the Pi extension with an injectable core for integration tests. */
export function createWikiExtension(options: WikiExtensionOptions) {
  const { core } = options;

  return function wikiExtension(pi: ExtensionAPI): void {
    let cwd = resolve(process.cwd());
    let mainModel: string | undefined;
    let modelRegistry: unknown;

    const makeOrch = (root: string): DisposableOrchestrator => {
      if (options.orchestratorFactory) {
        return options.orchestratorFactory({
          workspaceRoot: root,
          core,
          getMainModel: () => mainModel,
          getModelRegistry: () => modelRegistry,
        });
      }
      return createSessionOrchestrator({
        workspaceRoot: root,
        core,
        getTools: (r, role: WikiToolRole) => createWikiToolset(r, core, { role }),
        getMainModel: () => mainModel,
        getModelRegistry: () => modelRegistry,
      });
    };

    let orch = makeOrch(cwd);
    let unsubOrch: (() => void) | undefined;
    let capabilityNoticeSent = false;
    let lastUi: StatusUi | undefined;
    let proposedNoticeRunId: string | undefined;

    const bindObservation = (root: string, ui?: StatusUi) => {
      unsubOrch?.();
      if (ui) lastUi = ui;
      const targetUi = ui ?? lastUi;
      unsubOrch = orch.subscribe((snap) => {
        if (!targetUi) return;
        applyObservationUi(targetUi, snap);
        if (snap.overall === "proposed" && proposedNoticeRunId !== snap.orchestrationId) {
          proposedNoticeRunId = snap.orchestrationId;
          targetUi.notify?.("Wiki plan is ready. Open /wiki to review it, then press a to approve or r to reject. Non-interactive: /wiki approve.", "info");
        }
      });
      if (targetUi) void refreshObservation(core, orch, root, targetUi);
    };

    const getOrch = () => orch;
    pi.registerTool(createControlTool(pi, core, getOrch));

    const handleCommand = async (raw: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        await executeCommand(pi, core, getOrch(), resolve(ctx.cwd), parseWikiCommand(raw), ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`${message}\n${WIKI_COMMAND_USAGE}`, "warning");
      }
    };

    pi.registerCommand("wiki", {
      description:
        "OKF repository Wiki Navigator: phases, agents, execution streams, runs, sources, and controls.",
      getArgumentCompletions: (prefix) => getWikiArgumentCompletions(prefix),
      handler: (raw, ctx) => handleCommand(raw, ctx),
    });

    const aliases: Array<{ name: string; description: string; prefix: string }> = [
      { name: "wiki-help", description: "Show OKF Wiki command help", prefix: "help" },
      { name: "wiki-init", description: "Initialize an OKF Wiki workspace", prefix: "init" },
      { name: "wiki-generate", description: "Generate an OKF Wiki (optional focus)", prefix: "generate" },
      { name: "wiki-source", description: "Manage OKF Wiki sources (list|add|remove)", prefix: "source" },
    ];
    for (const alias of aliases) {
      pi.registerCommand(alias.name, {
        description: alias.description,
        getArgumentCompletions: (prefix) => getWikiArgumentCompletions(prefix),
        handler: (raw, ctx) => handleCommand(`${alias.prefix} ${raw}`.trim(), ctx),
      });
    }

    pi.on("session_start", async (_event, ctx) => {
      try {
        const sessionCwd = resolve(ctx.cwd || process.cwd());
        mainModel = mainModelSpec(ctx);
        modelRegistry = ctx.modelRegistry;

        if (sessionCwd !== cwd) {
          try {
            await orch.dispose?.();
          } catch {
            // ignore
          }
          unsubOrch?.();
          cwd = sessionCwd;
          orch = makeOrch(cwd);
        }

        ensureControlToolActive(pi);
        bindObservation(cwd, ctx.ui);

        if (!capabilityNoticeSent) {
          capabilityNoticeSent = true;
          try {
            pi.sendMessage(
              {
                customType: "okf-wiki-capability",
                content: `${CAPABILITY_NOTICE} Backend: ${orch.backend}.`,
                display: false,
              },
              { deliverAs: "nextTurn" },
            );
          } catch {
            // ignore
          }
        }

        await refreshObservation(core, orch, cwd, ctx.ui);
      } catch {
        // session_start must never throw
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      try {
        try {
          await orch.dispose?.();
        } catch {
          // ignore
        }
        unsubOrch?.();
        unsubOrch = undefined;
        ctx.ui?.setStatus?.(STATUS_KEY, undefined);
      } catch {
        // best-effort
      }
    });
  };
}

/** Build the production extension from the kit's async core. */
export function createProductionExtension(core: WikiCore = createWikiCore()) {
  return createWikiExtension({ core });
}
