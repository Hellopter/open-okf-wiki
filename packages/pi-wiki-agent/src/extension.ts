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
import { WIKI_COMMAND_USAGE, WikiCommandError, parseWikiCommand, type WikiCommand } from "./command.js";
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

function projectSource(root: string): { id: "project"; path: string; ignore: ["sources/**"] } {
  // The project source points at the workspace root. Managed source links live
  // under sources/, so it must not re-ingest those links as project files.
  return { id: "project", path: root, ignore: ["sources/**"] };
}

function statusText(status: WikiWorkspaceStatus, manager: WorkflowManager): string {
  const active = manager.listRuns().filter((run) => run.status === "running" || run.status === "paused");
  const sourceCount = status.sources.length;
  const run = status.activeRunId ? `domain run ${status.activeRunId}` : "no active domain run";
  const piRuns = active.length ? active.map((entry) => `${entry.runId} (${entry.status})`).join(", ") : "none";
  return `${status.initialized ? "Wiki workspace" : "No Wiki workspace"}: ${sourceCount} source${sourceCount === 1 ? "" : "s"}; ${run}; Pi workflows: ${piRuns}.`;
}

function compactStatus(status: WikiWorkspaceStatus, manager: WorkflowManager): string {
  return status.initialized ? statusText(status, manager) : "Wiki not initialized. Run /wiki init or /wiki <focus>.";
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

function formatSourceList(status: WikiWorkspaceStatus): string {
  if (status.sources.length === 0) return "No sources registered.";
  return status.sources.map((source) => `- ${source.id} (${source.kind}): ${source.root ?? source.url ?? ""}`).join("\n");
}

function output(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "okf-wiki", content, display: true });
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

async function executeCommand(
  pi: ExtensionAPI,
  core: CoreAdapter,
  manager: WorkflowManager,
  root: string,
  command: WikiCommand,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (command.action === "init") {
    const existing = await core.loadWorkspace(root);
    const initialized = await core.initWorkspace(root, { ...command, runtimeDefinition: WIKI_RUNTIME_DEFINITION });
    if (!existing?.initialized || command.force) {
      await core.addLinkedSource(root, projectSource(root));
    }
    await core.ensureRuntime(root, { runtimeDefinition: WIKI_RUNTIME_DEFINITION });
    ctx.ui.notify(compactStatus(initialized, manager), "info");
    return;
  }

  const workspace = await ensureWorkspace(core, root, { linkProjectOnCreate: true });
  switch (command.action) {
    case "status": {
      const status = await core.getWorkspaceStatus(root);
      output(pi, `${statusText(status, manager)}\n\n${formatSourceList(status)}`);
      return;
    }
    case "source-list":
      output(pi, formatSourceList(await core.getWorkspaceStatus(root)));
      return;
    case "source-add-clone": {
      const source = await core.addClonedSource(root, command);
      ctx.ui.notify(`Added cloned source ${source.id}.`, "info");
      return;
    }
    case "source-add-link": {
      const source = await core.addLinkedSource(root, { ...command, path: resolve(root, command.path) });
      ctx.ui.notify(`Added linked source ${source.id}.`, "info");
      return;
    }
    case "source-remove":
      await core.removeSource(root, command.sourceId);
      ctx.ui.notify(`Removed source ${command.sourceId}.`, "info");
      return;
    case "pause": {
      const workflowRunId = command.workflowRunId ?? activeWorkflowRunId(manager);
      if (!workflowRunId) throw new WikiCommandError("No active Pi workflow run to pause.");
      ctx.ui.notify(manager.pause(workflowRunId) ? `Paused Pi workflow ${workflowRunId}.` : `Cannot pause ${workflowRunId}.`, "info");
      return;
    }
    case "resume": {
      const workflowRunId = command.workflowRunId ?? activeWorkflowRunId(manager);
      if (!workflowRunId) throw new WikiCommandError("No paused Pi workflow run to resume.");
      const resumed = await manager.resume(workflowRunId);
      ctx.ui.notify(resumed ? `Resumed Pi workflow ${workflowRunId}.` : `Cannot resume ${workflowRunId}.`, resumed ? "info" : "warning");
      return;
    }
    case "stop": {
      const workflowRunId = command.workflowRunId ?? activeWorkflowRunId(manager);
      if (!workflowRunId) throw new WikiCommandError("No active Pi workflow run to stop.");
      ctx.ui.notify(manager.stop(workflowRunId) ? `Stopped Pi workflow ${workflowRunId}.` : `Cannot stop ${workflowRunId}.`, "info");
      return;
    }
    case "run": {
      if (command.mode === "write") {
        const status = await core.getWorkspaceStatus(root);
        if (!status.activeRunId) throw new WikiCommandError("No planned domain run is available for writing.");
        const gate = await core.checkPlanGate(root, { runId: status.activeRunId });
        if (!operationSucceeded(gate)) {
          if (!ctx.hasUI) throw new WikiCommandError("The plan gate requires interactive approval; run /wiki --write in Pi TUI.");
          const approved = await ctx.ui.confirm("Approve Wiki plan", "Start writing the checkpointed candidate Wiki from the current plan?");
          if (!approved) {
            ctx.ui.notify("Plan remains unapproved; no Wiki writing started.", "info");
            return;
          }
          const opened = await core.openPlanGate(root, { runId: status.activeRunId });
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
      return;
    }
  }
}

function createControlTool(pi: ExtensionAPI, core: CoreAdapter, getManager: () => WorkflowManager) {
  return defineTool({
    name: "okf_wiki",
    label: "OKF Wiki",
    description: "Start or inspect the checkpointed OKF repository Wiki workflow. Prefer the /wiki command for interactive run control.",
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
        return { content: [{ type: "text", text: statusText(status, getManager()) }], details: status };
      }
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

    installResultDelivery(pi, manager);
    suspendResultDelivery(manager);
    pi.registerTool(createControlTool(pi, core, getManager));
    pi.registerCommand("wiki", {
      description: "Run and manage the checkpointed repository Wiki workflow",
      async handler(raw, ctx) {
        try {
          await executeCommand(pi, core, getManager(), resolve(ctx.cwd), parseWikiCommand(raw), ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`${message}\n${WIKI_COMMAND_USAGE}`, "warning");
        }
      },
    });

    pi.on("session_start", (_event, ctx) => {
      const sessionCwd = resolve(ctx.cwd || process.cwd());
      if (sessionCwd !== cwd) {
        suspendResultDelivery(manager);
        for (const run of manager.listLiveRuns()) {
          if (run.status === "running") manager.pause(run.runId);
        }
        cwd = sessionCwd;
        manager = makeManager(cwd);
        installResultDelivery(pi, manager);
      }
      manager.setSessionId(ctx.sessionManager.getSessionId());
      manager.setMainModel(mainModelSpec(ctx));
      manager.setModelRegistry(ctx.modelRegistry);
      resumeResultDelivery(manager);
      if (ctx.hasUI) installTaskPanel(pi, manager, ctx.ui);
      void core.loadWorkspace(cwd).then((status) => {
        if (status?.initialized) ctx.ui.setStatus(STATUS_KEY, compactStatus(status, manager));
      }).catch(() => undefined);
    });

    pi.on("session_shutdown", () => {
      suspendResultDelivery(manager);
      for (const run of manager.listLiveRuns()) {
        if (run.status === "running") manager.pause(run.runId);
      }
    });
  };
}

/** Build the production extension from the core package's direct API exports. */
export function createProductionExtension(coreModule: Partial<CoreAdapter>) {
  return createWikiExtension({ core: createCoreAdapter(coreModule) });
}
