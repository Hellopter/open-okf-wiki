import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CoreAdapter, WikiRunMode, WikiRunPaths } from "./core-adapter.js";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`));
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeHostResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (typeof result.status === "string") return result;
  if (result.ok === true) return { ...result, status: "ok" };
  if (result.ok === false) return { ...result, status: "failed" };
  return result;
}

async function assertImmutableReviewArtifacts(
  adapter: CoreAdapter,
  root: string,
  params: { phase: string; artifactsJsonPath: string },
): Promise<void> {
  if (!/^review-\d+$/.test(params.phase) && !/^repair-\d+$/.test(params.phase)) return;
  const paths = await requireRunPaths(adapter, root);
  const artifactsPath = resolve(paths.workdir, params.artifactsJsonPath);
  await assertReadable(adapter, root, artifactsPath);
  const artifacts = JSON.parse(await readFile(artifactsPath, "utf8")) as unknown;
  if (!Array.isArray(artifacts)) return;
  const allowedReceiptPrefix = params.phase.startsWith("review-")
    ? "analysis/receipts/review/"
    : "analysis/receipts/repair/";
  const hasMutableOrNonReceiptArtifact = artifacts.some((artifact) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
    const path = (artifact as Record<string, unknown>).path;
    return typeof path !== "string" || !path.replace(/^\.\//, "").startsWith(allowedReceiptPrefix);
  });
  if (hasMutableOrNonReceiptArtifact) {
    throw new Error(`Review and repair checkpoints may declare only immutable receipts under ${allowedReceiptPrefix}`);
  }
}

async function noSymlinkBetween(root: string, target: string): Promise<void> {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (!inside(normalizedRoot, normalizedTarget)) throw new Error("Path escapes the active Wiki run");

  const rel = relative(normalizedRoot, normalizedTarget);
  let current = normalizedRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not permitted: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

async function requireRunPaths(adapter: CoreAdapter, root: string): Promise<WikiRunPaths> {
  const paths = await adapter.getRunPaths(root);
  if (!paths) throw new Error("No active Wiki run. Start /wiki before using Wiki workflow tools.");
  return paths;
}

async function assertReadable(adapter: CoreAdapter, root: string, target: string): Promise<void> {
  const paths = await requireRunPaths(adapter, root);
  const candidate = resolve(target);
  const allowed = [paths.inputsDir, paths.sourcesDir, paths.methodDir, paths.analysisDir, paths.candidateDir].some((dir) => inside(resolve(dir), candidate));
  if (!allowed) throw new Error("Read is limited to the active Wiki run's inputs, sources, method, analysis, and candidate directories");
  await noSymlinkBetween(paths.workdir, candidate);
}

async function assertWritable(adapter: CoreAdapter, root: string, target: string): Promise<void> {
  const paths = await requireRunPaths(adapter, root);
  const candidate = resolve(target);
  const receipts = resolve(paths.analysisDir, "receipts");
  const plannedArtifacts = [
    resolve(paths.analysisDir, "spec.json"),
    resolve(paths.analysisDir, "page-assignments.json"),
    resolve(paths.analysisDir, "defects.json"),
    resolve(paths.analysisDir, "validation.json"),
  ];
  const allowed = inside(receipts, candidate) || inside(resolve(paths.candidateDir), candidate) || plannedArtifacts.includes(candidate);
  if (!allowed) {
    throw new Error("Writes are limited to active-run receipts, plan artifacts, and owned candidate pages");
  }
  await noSymlinkBetween(paths.workdir, candidate);
}

async function assertWritableDirectory(adapter: CoreAdapter, root: string, target: string): Promise<void> {
  const paths = await requireRunPaths(adapter, root);
  const candidate = resolve(target);
  const allowed =
    candidate === resolve(paths.analysisDir) ||
    inside(resolve(paths.analysisDir, "receipts"), candidate) ||
    inside(resolve(paths.candidateDir), candidate);
  if (!allowed) throw new Error("Directory creation is limited to the active Wiki data plane");
  await noSymlinkBetween(paths.workdir, candidate);
}

/**
 * The only filesystem tools exposed to workflow subagents. `bash`, `grep`, and
 * `find` intentionally stay absent: every writable target is checked against
 * the active run's data plane before the Pi built-in performs I/O.
 */
export function createWikiFilesystemTools(root: string, adapter: CoreAdapter): ToolDefinition<any, any>[] {
  return [
    createReadToolDefinition(root, {
      operations: {
        async readFile(path) {
          await assertReadable(adapter, root, path);
          return readFile(path);
        },
        async access(path) {
          await assertReadable(adapter, root, path);
          await access(path);
        },
      },
    }),
    createLsToolDefinition(root, {
      operations: {
        async exists(path) {
          try {
            await assertReadable(adapter, root, path);
            await access(path);
            return true;
          } catch {
            return false;
          }
        },
        async stat(path) {
          await assertReadable(adapter, root, path);
          return stat(path);
        },
        async readdir(path) {
          await assertReadable(adapter, root, path);
          return readdir(path);
        },
      },
    }),
    createWriteToolDefinition(root, {
      operations: {
        async mkdir(path) {
          await assertWritableDirectory(adapter, root, path);
          await mkdir(path, { recursive: true });
        },
        async writeFile(path, content) {
          await assertWritable(adapter, root, path);
          await writeFile(path, content, "utf8");
        },
      },
    }),
    createEditToolDefinition(root, {
      operations: {
        async readFile(path) {
          await assertWritable(adapter, root, path);
          return readFile(path);
        },
        async writeFile(path, content) {
          await assertWritable(adapter, root, path);
          await writeFile(path, content, "utf8");
        },
        async access(path) {
          await assertWritable(adapter, root, path);
          await access(path);
        },
      },
    }),
  ];
}

function hostTool<T>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  execute: (params: any) => Promise<unknown>,
): ToolDefinition<any> {
  return defineTool({
    name,
    label,
    description,
    parameters: parameters as any,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = normalizeHostResult(await execute(params));
      return { content: [{ type: "text", text: json(result) }], details: result };
    },
  });
}

/** Domain control tools only exist in the named `wiki` subagent toolset. */
export function createWikiHostTools(root: string, adapter: CoreAdapter): ToolDefinition<any, any>[] {
  const run = Type.Object({ runId: Type.String({ minLength: 1 }) });
  return [
    hostTool(
      "okf_prepare",
      "Prepare Wiki run",
      "Prepare or resume the checkpointed Wiki run. Call this before inspecting or writing run artifacts.",
      Type.Object({
        mode: Type.Union([
          Type.Literal("auto"),
          Type.Literal("plan"),
          Type.Literal("write"),
          Type.Literal("restart"),
          Type.Literal("retry-plan"),
          Type.Literal("retry-write"),
        ]),
        focus: Type.Optional(Type.String()),
      }),
      (params: { mode: WikiRunMode; focus?: string }) => adapter.prepareRun(root, params),
    ),
    hostTool(
      "okf_survey_merge",
      "Merge survey receipts",
      "Validate survey receipts and publish the deterministic discovery map. Call only after all assigned surveyors wrote receipts.",
      Type.Object({ runId: Type.String({ minLength: 1 }), pass: Type.Integer({ minimum: 1 }), labelsPath: Type.Optional(Type.String()) }),
      (params) => adapter.mergeSurveyReceipts(root, params),
    ),
    hostTool(
      "okf_publish",
      "Publish checkpoint",
      "Validate declared artifacts and advance the authoritative Wiki checkpoint for one phase.",
      Type.Object({ runId: Type.String({ minLength: 1 }), phase: Type.String({ minLength: 1 }), artifactsJsonPath: Type.String({ minLength: 1 }) }),
      async (params) => {
        await assertImmutableReviewArtifacts(adapter, root, params);
        return adapter.publishCheckpoint(root, params);
      },
    ),
    hostTool(
      "okf_plan_gate_status",
      "Check plan gate",
      "Read the current plan-gate state. This tool cannot approve a plan; only the interactive /wiki --write command can do that.",
      run,
      (params: { runId: string }) => adapter.checkPlanGate(root, params),
    ),
    hostTool(
      "okf_validate",
      "Validate candidate Wiki",
      "Run deterministic candidate validation and prepare the exact validation artifact list for the final checkpoint.",
      run,
      async (params: { runId: string }) => {
        const raw = await adapter.validateCandidate(root, params);
        const result = normalizeHostResult(raw) as Record<string, unknown>;
        if (result.status !== "ok") return result;
        const paths = await adapter.getRunPaths(root, { runId: params.runId });
        if (!paths) throw new Error("Validation completed but the active run paths are unavailable");
        const validationPath = resolve(paths.analysisDir, "validation.json");
        const artifactsPath = resolve(paths.analysisDir, "receipts", "validate-artifacts.json");
        await assertWritable(adapter, root, validationPath);
        await assertWritable(adapter, root, artifactsPath);
        await mkdir(dirname(artifactsPath), { recursive: true });
        await writeFile(validationPath, `${json(raw)}\n`, "utf8");
        await writeFile(
          artifactsPath,
          `${json([
            { id: "validation", type: "validation", path: "analysis/validation.json" },
            { id: "candidate-manifest", type: "candidate-manifest", path: "analysis/candidate.manifest.json" },
          ])}\n`,
          "utf8",
        );
        return { ...result, artifactsJsonPath: "analysis/receipts/validate-artifacts.json" };
      },
    ),
    hostTool(
      "okf_workspace_status",
      "Read Wiki workspace status",
      "Return the authoritative workspace and active-run status without mutating state.",
      Type.Object({}),
      () => adapter.getWorkspaceStatus(root),
    ),
  ];
}

export function createWikiToolset(root: string, adapter: CoreAdapter): ToolDefinition<any, any>[] {
  return [...createWikiFilesystemTools(root, adapter), ...createWikiHostTools(root, adapter)];
}
