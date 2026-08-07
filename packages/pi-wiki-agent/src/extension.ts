import { resolve } from "node:path";
import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  installResultDelivery,
  installTaskPanel,
  resumeResultDelivery,
  suspendResultDelivery,
  WorkflowManager,
} from "@quintinshaw/pi-dynamic-workflows";
import {
  formatWikiHelp,
  getWikiArgumentCompletions,
  parseWikiCommand,
  WIKI_COMMAND_USAGE,
  WikiCommandError,
  type WikiCommand,
} from "./command.js";
import { createCoreAdapter, type CoreAdapter, type WikiWorkspaceStatus } from "./core-adapter.js";
import { createWikiToolset } from "./toolset.js";
import { WIKI_RUNTIME_DEFINITION } from "./runtime.js";
import { WIKI_WORKFLOW_SCRIPT } from "./wiki-workflow.js";

export interface WikiWorkflowInvocation {
  /** Pi's background workflow id. Never confuse this with domainRunId. */
  workflowRunId?: string;
  workspaceRoot: string;
  request: { mode: string; focus?: string };
}

export interface WikiExtensionOptions {
  core: CoreAdapter;
  managerFactory?: (options: ConstructorParameters<typeof WorkflowManager>[0]) => WorkflowManager;
}

const TOOLSET_NAME = "okf-wiki";
const STATUS_KEY = "okf-wiki";
const CONTROL_TOOL_NAME = "okf_wiki";

const CAPABILITY_NOTICE =
  "OKF Wiki (@okf-wiki/pi-wiki-agent) is loaded: checkpointed repository Wiki production. " +
  "Not pi-llm-wiki (personal knowledge base). Use /wiki help for commands. " +
  "Aliases: /wiki-status /wiki-init /wiki-run /wiki-source /wiki-help.";

type StatusUi = { setStatus: (key: string, text: string | undefined) => void };

function projectSource(root: string): { id: "project"; path: string; ignore: ["sources/**"] } {
  // The project source points at the workspace root. Managed source links live
  // under sources/, so it must not re-ingest those links as project files.
  return { id: "project", path: root, ignore: ["sources/**"] };
}

function formatSourceList(status: WikiWorkspaceStatus): string {
  if (status.sources.length === 0) return "No sources registered.";
  return status.sources.map((source) => `- ${source.id} (${source.kind}): ${source.root ?? source.url ?? ""}`).join("\n");
}

function formatPiWorkflowRuns(manager: WorkflowManager): string {
  const runs = manager.listRuns();
  if (runs.length === 0) return "none";
  const active = runs.filter((run) => run.status === "running" || run.status === "paused");
  const shown = (active.length ? active : runs.slice(0, 5)).map((entry) => `${entry.runId} (${entry.status})`);
  return shown.join(", ") || "none";
}

/** Compact one-line status for the Pi status bar. */
function compactStatus(status: WikiWorkspaceStatus, manager: WorkflowManager): string {
  if (!status.initialized) return "Wiki not initialized. Run /wiki init or /wiki help.";
  const sourceCount = status.sources.length;
  const domain =
    status.active?.runId || status.activeRunId
      ? `domain ${status.active?.runId ?? status.activeRunId}${status.active?.status ? ` (${status.active.status})` : ""}`
      : "no active domain run";
  const piRuns = formatPiWorkflowRuns(manager);
  return `Wiki: ${sourceCount} source${sourceCount === 1 ? "" : "s"}; ${domain}; Pi: ${piRuns}.`;
}

/** Full multi-line status for `/wiki status`. */
function formatFullStatus(status: WikiWorkspaceStatus, manager: WorkflowManager): string {
  const lines: string[] = [];
  if (!status.initialized) {
    lines.push(`No Wiki workspace at ${status.root}`);
    lines.push("Run /wiki init to create one, or /wiki help for the full command surface.");
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
  } else if (!status.active?.runId && !status.activeRunId) {
    lines.push("- recent: none");
  }

  lines.push("");
  lines.push(`Pi workflow runs: ${formatPiWorkflowRuns(manager)}`);
  if (status.summary) {
    lines.push("");
    lines.push(status.summary);
  }
  return lines.join("\n");
}

function mainModelSpec(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  if (!model?.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function activeWorkflowRunId(manager: WorkflowManager): string | undefined {
  return manager
    .listRuns()
    .filter((run) => run.status === "running" || run.status === "paused")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.runId;
}

function operationSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as { ok?: unknown; status?: unknown };
  return result.ok === true || result.status === "ok";
}

function output(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "okf-wiki", content, display: true });
}

function pauseLiveRuns(manager: WorkflowManager): number {
  let paused = 0;
  const live =
    typeof manager.listLiveRuns === "function"
      ? manager.listLiveRuns()
      : manager.listRuns().filter((run) => run.status === "running" || run.status === "paused");
  for (const run of live) {
    if (run.status === "running" && manager.pause(run.runId)) paused++;
  }
  return paused;
}

async function refreshStatus(
  core: CoreAdapter,
  manager: WorkflowManager,
  root: string,
  ui: StatusUi,
): Promise<void> {
  try {
    const status = await core.loadWorkspace(root);
    if (status?.initialized) {
      // Prefer full status when available for richer domain run info.
      let full = status;
      try {
        full = await core.getWorkspaceStatus(root);
      } catch {
        // loadWorkspace summary is enough for the status bar.
      }
      ui.setStatus(STATUS_KEY, compactStatus(full, manager));
    } else {
      ui.setStatus(STATUS_KEY, "Wiki not initialized. Run /wiki init or /wiki help.");
    }
  } catch {
    // Status refresh must never surface as a session failure.
  }
}

async function ensureWorkspace(core: CoreAdapter, root: string, options: { linkProjectOnCreate?: boolean } = {}): Promise<WikiWorkspaceStatus> {
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

const NO_WORKSPACE_HINT = "No Wiki workspace. Run /wiki init.";

async function executeCommand(
  pi: ExtensionAPI,
  core: CoreAdapter,
  manager: WorkflowManager,
  root: string,
  command: WikiCommand,
  ctx: ExtensionCommandContext,
): Promise<void> {
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
    ctx.ui.notify(compactStatus(initialized, manager), "info");
    await refreshStatus(core, manager, root, ctx.ui);
    return;
  }

  // Read/control commands must not auto-init a workspace.
  if (command.action === "status") {
    const existing = await core.loadWorkspace(root);
    if (!existing?.initialized) {
      output(pi, NO_WORKSPACE_HINT);
      await refreshStatus(core, manager, root, ctx.ui);
      return;
    }
    const status = await core.getWorkspaceStatus(root);
    output(pi, formatFullStatus(status, manager));
    await refreshStatus(core, manager, root, ctx.ui);
    return;
  }

  if (command.action === "source-list") {
    const existing = await core.loadWorkspace(root);
    if (!existing?.initialized) {
      output(pi, NO_WORKSPACE_HINT);
      await refreshStatus(core, manager, root, ctx.ui);
      return;
    }
    output(pi, formatSourceList(await core.getWorkspaceStatus(root)));
    await refreshStatus(core, manager, root, ctx.ui);
    return;
  }

  // Pause/resume/stop operate only on Pi WorkflowManager state.
  if (command.action === "pause") {
    const workflowRunId = command.workflowRunId ?? activeWorkflowRunId(manager);
    if (!workflowRunId) throw new WikiCommandError("No active Pi workflow run to pause.");
    ctx.ui.notify(manager.pause(workflowRunId) ? `Paused Pi workflow ${workflowRunId}.` : `Cannot pause ${workflowRunId}.`, "info");
    await refreshStatus(core, manager, root, ctx.ui);
    return;
  }
  if (command.action === "resume") {
    const workflowRunId = command.workflowRunId ?? activeWorkflowRunId(manager);
    if (!workflowRunId) throw new WikiCommandError("No paused Pi workflow run to resume.");
    const resumed = await manager.resume(workflowRunId);
    ctx.ui.notify(resumed ? `Resumed Pi workflow ${workflowRunId}.` : `Cannot resume ${workflowRunId}.`, resumed ? "info" : "warning");
    await refreshStatus(core, manager, root, ctx.ui);
    return;
  }
  if (command.action === "stop") {
    const workflowRunId = command.workflowRunId ?? activeWorkflowRunId(manager);
    if (!workflowRunId) throw new WikiCommandError("No active Pi workflow run to stop.");
    ctx.ui.notify(manager.stop(workflowRunId) ? `Stopped Pi workflow ${workflowRunId}.` : `Cannot stop ${workflowRunId}.`, "info");
    await refreshStatus(core, manager, root, ctx.ui);
    return;
  }

  // Source removal requires an existing workspace; do not silently create one.
  if (command.action === "source-remove") {
    const existing = await core.loadWorkspace(root);
    if (!existing?.initialized) throw new WikiCommandError(NO_WORKSPACE_HINT);
    await core.removeSource(root, command.sourceId);
    ctx.ui.notify(`Removed source ${command.sourceId}.`, "info");
    await refreshStatus(core, manager, root, ctx.ui);
    return;
  }

  // Productive paths: source-add and run may auto-init on first use.
  const workspace = await ensureWorkspace(core, root, { linkProjectOnCreate: true });
  switch (command.action) {
    case "source-add-clone": {
      const source = await core.addClonedSource(root, command);
      ctx.ui.notify(`Added cloned source ${source.id}.`, "info");
      await refreshStatus(core, manager, root, ctx.ui);
      return;
    }
    case "source-add-link": {
      const source = await core.addLinkedSource(root, { ...command, path: resolve(root, command.path) });
      ctx.ui.notify(`Added linked source ${source.id}.`, "info");
      await refreshStatus(core, manager, root, ctx.ui);
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
          if (!ctx.hasUI) throw new WikiCommandError("The plan gate requires interactive approval; run /wiki --write in Pi TUI.");
          const approved = await ctx.ui.confirm("Approve Wiki plan", "Start writing the checkpointed candidate Wiki from the current plan?");
          if (!approved) {
            ctx.ui.notify("Plan remains unapproved; no Wiki writing started.", "info");
            return;
          }
          const opened = await core.openPlanGate(root, { runId });
          if (!operationSucceeded(opened)) throw new WikiCommandError("Plan approval did not complete; inspect /wiki status.");
        }
      }
      const invocation: WikiWorkflowInvocation = {
        workspaceRoot: workspace.root,
        request: { mode: command.mode, focus: command.focus },
      };
      const started = manager.startInBackground(WIKI_WORKFLOW_SCRIPT, invocation, {
        toolset: TOOLSET_NAME,
        concurrency: 4,
        maxAgents: 48,
        agentRetries: 1,
      });
      // The manager's run id is scheduler state. The core's domain run id is
      // returned by okf_prepare and is reported by workflow results/status.
      invocation.workflowRunId = started.runId;
      ctx.ui.notify(`Started Pi workflow ${started.runId}; domain run id will be reported after Bootstrap.`, "info");
      await refreshStatus(core, manager, root, ctx.ui);
      return;
    }
  }
}

function createControlTool(pi: ExtensionAPI, core: CoreAdapter, getManager: () => WorkflowManager) {
  return defineTool({
    name: CONTROL_TOOL_NAME,
    label: "OKF Wiki",
    description:
      "Start or inspect the checkpointed OKF repository Wiki workflow. Prefer the /wiki command for interactive run control. Not pi-llm-wiki.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("run"), Type.Literal("status")]),
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
      if (params.action === "status") {
        const status = await core.getWorkspaceStatus(root);
        return { content: [{ type: "text", text: formatFullStatus(status, getManager()) }], details: status };
      }
      // Block only `write`: that mode opens the plan gate and requires interactive
      // `/wiki --write` approval. `retry-write` resumes an already-approved write
      // path and does not re-open the gate from this tool.
      if (params.mode === "write") {
        throw new Error("Use /wiki --write to approve a plan before starting candidate writing");
      }
      const workspace = await ensureWorkspace(core, root, { linkProjectOnCreate: true });
      const invocation: WikiWorkflowInvocation = {
        workspaceRoot: workspace.root,
        request: { mode: params.mode ?? "auto", focus: params.focus },
      };
      const started = getManager().startInBackground(WIKI_WORKFLOW_SCRIPT, invocation, {
        toolset: TOOLSET_NAME,
        concurrency: 4,
        maxAgents: 48,
        agentRetries: 1,
      });
      invocation.workflowRunId = started.runId;
      return {
        content: [{ type: "text", text: `Started Pi workflow ${started.runId}. The domain run id is produced by Bootstrap.` }],
        details: { workflowRunId: started.runId, workspaceRoot: workspace.root },
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
    // Optional capability — older Pi hosts may not expose tool activation APIs.
  }
}

function adoptLiveRunsIfSupported(manager: WorkflowManager, sessionId: string | undefined): void {
  const adopt = (manager as WorkflowManager & { adoptLiveRunsToSession?: (id: string | undefined) => number }).adoptLiveRunsToSession;
  if (typeof adopt === "function") {
    try {
      adopt.call(manager, sessionId);
    } catch {
      // Feature-detect only; adoption is best-effort across manager versions.
    }
  }
}

/** Register the Pi extension with an injectable core for integration tests. */
export function createWikiExtension(options: WikiExtensionOptions) {
  const { core } = options;
  return function wikiExtension(pi: ExtensionAPI): void {
    let cwd = resolve(process.cwd());
    const makeManager = (root: string): WorkflowManager => {
      const factory = options.managerFactory ?? ((managerOptions) => new WorkflowManager(managerOptions));
      return factory({
        cwd: root,
        concurrency: 4,
        defaultAgentRetries: 1,
        toolsets: { [TOOLSET_NAME]: () => createWikiToolset(root, core) },
      });
    };
    let manager = makeManager(cwd);
    const getManager = () => manager;
    let capabilityNoticeSent = false;

    // Factory order: install delivery → suspend → register tools/commands → hooks.
    installResultDelivery(pi, manager);
    suspendResultDelivery(manager);
    pi.registerTool(createControlTool(pi, core, getManager));

    const handleCommand = async (raw: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        await executeCommand(pi, core, getManager(), resolve(ctx.cwd), parseWikiCommand(raw), ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`${message}\n${WIKI_COMMAND_USAGE}`, "warning");
      }
    };

    pi.registerCommand("wiki", {
      description:
        "OKF repository Wiki: help, status, init, run, sources, pause/resume/stop. Empty /wiki shows help (not auto-run). Not pi-llm-wiki.",
      getArgumentCompletions: (prefix) => getWikiArgumentCompletions(prefix),
      handler: (raw, ctx) => handleCommand(raw, ctx),
    });

    // Convenience aliases share the same executor with a fixed subcommand prefix.
    const aliases: Array<{ name: string; description: string; prefix: string }> = [
      { name: "wiki-help", description: "Show OKF Wiki command help", prefix: "help" },
      { name: "wiki-status", description: "Show OKF Wiki workspace and run status", prefix: "status" },
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
      // session_start must NEVER throw — wrap the entire status path.
      try {
        const sessionCwd = resolve(ctx.cwd || process.cwd());
        let pausedForMismatch = 0;

        if (sessionCwd !== cwd) {
          suspendResultDelivery(manager);
          pausedForMismatch = pauseLiveRuns(manager);
          cwd = sessionCwd;
          manager = makeManager(cwd);
          // Install delivery for the new manager but stay suspended until bound.
          installResultDelivery(pi, manager);
          suspendResultDelivery(manager);
        }

        let sessionId: string | undefined;
        try {
          sessionId = ctx.sessionManager?.getSessionId();
        } catch {
          // sessionManager may be unavailable — fall back to unbound history.
        }
        manager.setSessionId(sessionId);
        manager.setMainModel(mainModelSpec(ctx));
        manager.setModelRegistry(ctx.modelRegistry);
        adoptLiveRunsIfSupported(manager, sessionId);
        ensureControlToolActive(pi);

        if (ctx.hasUI) {
          try {
            installTaskPanel(pi, manager, ctx.ui);
          } catch {
            // Task panel is optional UI chrome.
          }
        }

        resumeResultDelivery(manager);

        if (pausedForMismatch > 0) {
          ctx.ui.notify(
            `Paused ${pausedForMismatch} active wiki workflow(s) that could not safely continue after switching projects. Resume with /wiki resume when ready.`,
            "warning",
          );
        }

        if (!capabilityNoticeSent) {
          capabilityNoticeSent = true;
          try {
            pi.sendMessage(
              { customType: "okf-wiki-capability", content: CAPABILITY_NOTICE, display: false },
              { deliverAs: "nextTurn" },
            );
          } catch {
            // Optional context injection — ignore hosts that reject it.
          }
        }

        await refreshStatus(core, manager, cwd, ctx.ui);
      } catch {
        // Intentionally swallow: a bad status refresh must not kill the session.
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      try {
        suspendResultDelivery(manager);
        pauseLiveRuns(manager);
        ctx.ui?.setStatus?.(STATUS_KEY, undefined);
      } catch {
        // Shutdown cleanup is best-effort.
      }
    });
  };
}

/** Build the production extension from the core package's direct API exports. */
export function createProductionExtension(coreModule: Partial<CoreAdapter>) {
  return createWikiExtension({ core: createCoreAdapter(coreModule) });
}
