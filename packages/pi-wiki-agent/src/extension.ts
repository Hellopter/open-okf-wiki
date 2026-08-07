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
import { createCoreAdapter, type CoreAdapter, type WikiWorkspaceStatus } from "./core-adapter.js";
import {
  formatStatusBar,
  openWikiNavigator,
} from "./observe/index.js";
import {
  createSessionOrchestrator,
  DEFAULT_ORCH_LIMITS,
  scanSurveyCoverage,
  type WikiOrchestrator,
  type WikiProgressSnapshot,
} from "./orch/index.js";
import { createWikiToolset } from "./toolset.js";
import { WIKI_RUNTIME_DEFINITION } from "./runtime.js";

export type DisposableOrchestrator = WikiOrchestrator & { dispose?: () => void };

export interface WikiExtensionOptions {
  core: CoreAdapter;
  /** Inject orchestrator (tests). Defaults to SessionWikiOrchestrator. */
  orchestratorFactory?: (options: {
    workspaceRoot: string;
    core: CoreAdapter;
    getMainModel: () => string | undefined;
    getModelRegistry: () => unknown;
  }) => DisposableOrchestrator;
}

const STATUS_KEY = "okf-wiki";
const CONTROL_TOOL_NAME = "okf_wiki";
const OBSERVE_OPTS = { staleWarnMs: DEFAULT_ORCH_LIMITS.staleWarnMs };

const CAPABILITY_NOTICE =
  "OKF Wiki (@okf-wiki/pi-wiki-agent) is loaded: checkpointed repository Wiki production. " +
  "Not pi-llm-wiki (personal knowledge base). Use /wiki help for commands. " +
  "Session orchestration: Bootstrap→Survey→Plan→Gate→Write→Verify→Repair→Validate. " +
  "Open /wiki to observe phases, agents, and execution streams.";

type StatusUi = {
  setStatus: (key: string, text: string | undefined) => void;
};

function projectSource(root: string): { id: "project"; path: string; ignore: ["sources/**"] } {
  return { id: "project", path: root, ignore: ["sources/**"] };
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

function operationSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as { ok?: unknown; status?: unknown };
  return result.ok === true || result.status === "ok";
}

function output(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "okf-wiki", content, display: true });
}

async function enrichCoverage(orch: WikiOrchestrator, core: CoreAdapter, root: string): Promise<void> {
  try {
    const snap = orch.getActiveSnapshot();
    let workdir = snap?.workdir;
    if (!workdir) {
      const paths = await core.getRunPaths(root);
      workdir = paths?.workdir;
    }
    if (!workdir || !orch.updateSnapshot) return;
    const coverage = await scanSurveyCoverage(workdir);
    if (!coverage) return;
    orch.updateSnapshot((s) => {
      s.coverage = coverage;
      if (!s.workdir) s.workdir = workdir;
    });
  } catch {
    // ignore
  }
}

function formatWorkspaceStatus(status: WikiWorkspaceStatus): string {
  const lines: string[] = [];
  if (!status.initialized) {
    lines.push(`No Wiki workspace at ${status.root}`);
    lines.push("Run /wiki init to create one.");
    return lines.join("\n");
  }

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
    const workdir = status.active?.workdir ? ` workdir=${status.active.workdir}` : "";
    lines.push(`- active: ${id}${st}${workdir}`);
  } else {
    lines.push("- active: none");
  }
  if (status.runs && status.runs.length > 0) {
    for (const run of status.runs.slice(0, 10)) {
      const marker = run.runId === (status.active?.runId ?? status.activeRunId) ? " (current)" : "";
      lines.push(`- ${run.runId}${run.status ? ` [${run.status}]` : ""}${marker}`);
    }
  }

  if (status.summary) {
    lines.push("");
    lines.push(status.summary);
  }
  return lines.join("\n");
}

async function readWorkspaceStatus(core: CoreAdapter, root: string): Promise<WikiWorkspaceStatus> {
  const workspace = await core.loadWorkspace(root);
  if (workspace?.initialized) return core.getWorkspaceStatus(root);
  return workspace ?? { root, initialized: false, sources: [] };
}

function applyObservationUi(ui: StatusUi, snap: WikiProgressSnapshot | undefined, workspace?: WikiWorkspaceStatus): void {
  if (snap) {
    ui.setStatus(STATUS_KEY, formatStatusBar(snap, OBSERVE_OPTS));
    return;
  }
  if (workspace && !workspace.initialized) {
    ui.setStatus(STATUS_KEY, "Wiki not initialized. Run /wiki init or /wiki help.");
  } else if (workspace) {
    const n = workspace.sources.length;
    ui.setStatus(STATUS_KEY, `Wiki: ${n} source${n === 1 ? "" : "s"}; no active orch run.`);
  } else {
    ui.setStatus(STATUS_KEY, "Wiki not initialized. Run /wiki init or /wiki help.");
  }
}

async function refreshObservation(
  core: CoreAdapter,
  orch: WikiOrchestrator,
  root: string,
  ui: StatusUi,
): Promise<void> {
  try {
    orch.syncFromBackend();
    await enrichCoverage(orch, core, root);
    let workspace: WikiWorkspaceStatus | undefined;
    try {
      workspace = await core.loadWorkspace(root);
      if (workspace?.initialized) {
        try {
          workspace = await core.getWorkspaceStatus(root);
        } catch {
          // keep loadWorkspace
        }
      }
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
  core: CoreAdapter,
  root: string,
  options: { linkProjectOnCreate?: boolean } = {},
): Promise<WikiWorkspaceStatus> {
  const existing = await core.loadWorkspace(root);
  const created = !existing?.initialized;
  const workspace = existing?.initialized
    ? existing
    : await core.initWorkspace(root, { runtimeDefinition: WIKI_RUNTIME_DEFINITION });
  if (created && options.linkProjectOnCreate) {
    await core.addLinkedSource(root, projectSource(root));
  }
  await core.ensureRuntime(root, { runtimeDefinition: WIKI_RUNTIME_DEFINITION });
  return workspace;
}

function transcriptToLines(entries: unknown[]): string[] {
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return String(entry);
    const row = entry as Record<string, unknown>;
    const role = row.role ?? row.kind ?? "entry";
    const tool = row.toolName ? ` ${row.toolName}` : "";
    const path = row.path ? ` ${row.path}` : "";
    const text = typeof row.text === "string" ? row.text : JSON.stringify(row);
    const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return `[${role}${tool}${path}] ${clipped}`;
  });
}

async function openNavigator(
  core: CoreAdapter,
  orch: WikiOrchestrator,
  root: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  orch.syncFromBackend();
  await enrichCoverage(orch, core, root);
  const workspace = await readWorkspaceStatus(core, root);
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
      getTranscript: async (agentId) => transcriptToLines(await orch.getTranscript(agentId, { tail: 120 })),
      onPause: () => orch.pause(),
      onResume: () => orch.resume(),
      onStop: () => orch.stop(),
      formatOpts: OBSERVE_OPTS,
    },
  );
}

async function executeCommand(
  pi: ExtensionAPI,
  core: CoreAdapter,
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
    const existing = await core.loadWorkspace(root);
    const initialized = await core.initWorkspace(root, { ...command, runtimeDefinition: WIKI_RUNTIME_DEFINITION });
    if (!existing?.initialized || command.force) {
      await core.addLinkedSource(root, projectSource(root));
    }
    await core.ensureRuntime(root, { runtimeDefinition: WIKI_RUNTIME_DEFINITION });
    ctx.ui.notify(`Wiki initialized at ${initialized.root}`, "info");
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
    const existing = await core.loadWorkspace(root);
    if (!existing?.initialized) {
      output(pi, NO_WORKSPACE_HINT);
      await refreshObservation(core, orch, root, ctx.ui);
      return;
    }
    output(pi, formatSourceList(await core.getWorkspaceStatus(root)));
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
    const existing = await core.loadWorkspace(root);
    if (!existing?.initialized) throw new WikiCommandError(NO_WORKSPACE_HINT);
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
    case "run": {
      if (command.mode === "write") {
        const status = await core.getWorkspaceStatus(root);
        if (!status.activeRunId && !status.active?.runId) {
          throw new WikiCommandError("No planned domain run is available for writing.");
        }
        const runId = status.activeRunId ?? status.active!.runId;
        const gate = await core.checkPlanGate(root, { runId });
        if (!operationSucceeded(gate)) {
          if (!ctx.hasUI) {
            throw new WikiCommandError("The plan gate requires interactive approval; run /wiki --write in Pi TUI.");
          }
          const approved = await ctx.ui.confirm(
            "Approve Wiki plan",
            "Start writing the checkpointed candidate Wiki from the current plan?",
          );
          if (!approved) {
            ctx.ui.notify("Plan remains unapproved; no Wiki writing started.", "info");
            return;
          }
          const opened = await core.openPlanGate(root, { runId });
          if (!operationSucceeded(opened)) {
            throw new WikiCommandError("Plan approval did not complete; check /wiki status --json.");
          }
        }
      }

      const started = await orch.start({
        workspaceRoot: workspace.root,
        mode: command.mode,
        focus: command.focus,
      });
      ctx.ui.notify(
        `Started wiki orch ${started.orchRunId}` +
          (started.domainRunId ? ` (domain ${started.domainRunId})` : "; domain run id after Bootstrap") +
          ". Open /wiki to observe.",
        "info",
      );
      await refreshObservation(core, orch, root, ctx.ui);
      return;
    }
  }
}

function createControlTool(pi: ExtensionAPI, core: CoreAdapter, getOrch: () => WikiOrchestrator) {
  return defineTool({
    name: CONTROL_TOOL_NAME,
    label: "OKF Wiki",
    description:
      "Start or inspect the checkpointed OKF repository Wiki workflow. Prefer /wiki for interactive control.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("run"),
        Type.Literal("status"),
        Type.Literal("stop"),
        Type.Literal("pause"),
        Type.Literal("resume"),
      ]),
      mode: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("plan"),
          Type.Literal("write"),
          Type.Literal("restart"),
          Type.Literal("retry-plan"),
          Type.Literal("retry-write"),
        ]),
      ),
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
          content: [{ type: "text", text: formatWorkspaceStatus(status) }],
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
      if (params.mode === "write") {
        throw new Error("Use /wiki --write to approve a plan before starting candidate writing");
      }
      const workspace = await ensureWorkspace(core, root, { linkProjectOnCreate: true });
      const started = await orch.start({
        workspaceRoot: workspace.root,
        mode: params.mode ?? "auto",
        focus: params.focus,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started wiki orch ${started.orchRunId}. Domain run id is produced by Bootstrap. Open /wiki to observe.`,
          },
        ],
        details: { orchRunId: started.orchRunId, domainRunId: started.domainRunId, workspaceRoot: workspace.root },
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
        getTools: (r) => createWikiToolset(r, core),
        getMainModel: () => mainModel,
        getModelRegistry: () => modelRegistry,
      });
    };

    let orch = makeOrch(cwd);
    let unsubOrch: (() => void) | undefined;
    let capabilityNoticeSent = false;
    let lastUi: StatusUi | undefined;

    const bindObservation = (root: string, ui?: StatusUi) => {
      unsubOrch?.();
      if (ui) lastUi = ui;
      const targetUi = ui ?? lastUi;
      unsubOrch = orch.subscribe((snap) => {
        if (!targetUi) return;
        applyObservationUi(targetUi, snap);
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
      { name: "wiki-run", description: "Start the OKF Wiki workflow (optional focus)", prefix: "run" },
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
            orch.dispose?.();
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

    pi.on("session_shutdown", (_event, ctx) => {
      try {
        unsubOrch?.();
        unsubOrch = undefined;
        try {
          orch.dispose?.();
        } catch {
          // ignore
        }
        ctx.ui?.setStatus?.(STATUS_KEY, undefined);
      } catch {
        // best-effort
      }
    });
  };
}

/** Build the production extension from the core package's direct API exports. */
export function createProductionExtension(coreModule: Partial<CoreAdapter>) {
  return createWikiExtension({ core: createCoreAdapter(coreModule) });
}
