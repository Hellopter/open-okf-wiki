import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import YAML from "yaml";
import { buildInventory, type Inventory } from "./inventory.js";
import { effectiveIgnores, pathIgnored } from "./ignores.js";
import { assertInside, methodSourceDirectory, relativePath, runPaths, workspacePaths } from "./layout.js";
import { copyDirectory, copyRegularFile, hashFile, hashTree, isRegularFile, pathExists, readJson, readText, realDirectory, writeJson, writeText } from "./storage.js";
import type {
  ApprovalMode,
  QualityReport,
  RunQuality,
  RunStatus,
  ResumeAt,
  RunPlanningCompletion,
  RunPreparation,
  RunResumption,
  RunValidationResult,
  WikiCore,
  WikiCoreDependencies,
  WikiLanguage,
  WikiRunPaths,
  WikiRunState,
  WikiRuntimeDefinition,
  WikiSource,
  WikiSourceSummary,
  WikiWorkspaceStatus,
} from "./types.js";

const executeFile = promisify(execFile);
const runStatuses = new Set<RunStatus>(["planning", "proposed", "writing", "validating", "quality_blocked", "paused", "stopped", "failed", "complete"]);
const approvalModes = new Set<ApprovalMode>(["propose", "auto"]);
const qualityStatuses = new Set<RunQuality["status"]>(["pending", "repairing", "blocked", "passed"]);
const sourceId = /^[a-z0-9][a-z0-9._-]*$/;
const digest = /^sha256:[a-f0-9]{64}$/;

interface WorkspaceDocument {
  version: 5;
  id: string;
  name: string;
  wikiLanguage: WikiLanguage;
  workflow: { approval: ApprovalMode };
  defaultSourceIgnores: { enabled: boolean };
  sources: WikiSource[];
  createdAt: string;
  updatedAt: string;
}

interface RunPolicy {
  version: 5;
  focus: string | null;
  discovery: { enabled: boolean; maxAgents: number };
  runtime: WikiRuntimeDefinition;
  methodDigest: string;
}

interface RunMeta { version: 5; runId: string; createdAt: string; focus: string | null }
interface CurrentPointer { version: 5; runId: string }
interface BundleManifest { version: 1; bundleDigest: string; sealedAt: string }
interface PageMatrixEntry { page: string; coverageUnits: string[]; evidence: string; diagram: "required" | "useful" | "omitted" }
interface RunClaimDocument { version: 2; runId: string; orchestrationId: string; pid: number; claimedAt: string }

function sourceSummary(source: WikiSource, effective: string[]): WikiSourceSummary {
  if (source.origin.type === "clone") return { ...source, kind: "clone", url: source.origin.remoteUrl, effectiveIgnores: effective };
  return { ...source, kind: "linked", root: source.origin.linkedPath, effectiveIgnores: effective };
}

function nowIso(now: () => Date): string { return now().toISOString(); }

function validateRuntime(runtime: WikiRuntimeDefinition): WikiRuntimeDefinition {
  if (runtime?.kind !== "pi") throw new Error("runtime.kind must be pi");
  if (!runtime.extension?.trim()) throw new Error("runtime.extension must be a non-empty package identifier");
  if (!runtime.workflow?.id?.trim()) throw new Error("runtime.workflow.id must be a non-empty string");
  if (!digest.test(runtime.workflow.digest)) throw new Error("runtime.workflow.digest must be a sha256 digest");
  return { kind: "pi", extension: runtime.extension.trim(), workflow: { id: runtime.workflow.id.trim(), digest: runtime.workflow.digest } };
}

function requireSourceId(value: string): string {
  if (!sourceId.test(value)) throw new Error(`invalid source id: ${value}`);
  return value;
}

function sourceSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("empty source id");
  return requireSourceId(slug);
}

function normalizeIgnorePatterns(patterns: string[] | undefined): string[] {
  if (!patterns) return [];
  if (!Array.isArray(patterns)) throw new Error("source ignore must be an array of patterns");
  return [...new Set(patterns.map((pattern) => {
    if (typeof pattern !== "string") throw new Error("source ignore patterns must be strings");
    const normalized = pattern.trim();
    if (normalized.startsWith("!")) throw new Error("negated source ignore patterns are not supported");
    return normalized;
  }).filter(Boolean))];
}

function defaultWorkspace(root: string, now: string, uuid: () => string, name?: string, wikiLanguage: WikiLanguage = "en"): WorkspaceDocument {
  return {
    version: 5,
    id: uuid(),
    name: name?.trim() || path.basename(root),
    wikiLanguage,
    workflow: { approval: "propose" },
    defaultSourceIgnores: { enabled: true },
    sources: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseWorkspace(text: string, filename: string): WorkspaceDocument {
  let parsed: unknown;
  try { parsed = YAML.parse(text); } catch (error: unknown) { throw new Error(`invalid workspace YAML (${filename}): ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`workspace config must be a YAML mapping: ${filename}`);
  const value = parsed as Partial<WorkspaceDocument>;
  if (value.version !== 5) throw new Error("unsupported workspace version; recreate the workspace with /wiki init --force");
  if (!Array.isArray(value.sources)) throw new Error("workspace sources must be an array");
  const approval = value.workflow?.approval ?? "propose";
  if (!approvalModes.has(approval)) throw new Error("workspace workflow.approval must be propose or auto");
  if (value.wikiLanguage !== "en" && value.wikiLanguage !== "zh") throw new Error("workspace wikiLanguage must be en or zh");
  return { ...value, workflow: { approval }, sources: value.sources as WikiSource[] } as WorkspaceDocument;
}

export function createWikiCore(dependencies: WikiCoreDependencies = {}): WikiCore {
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const defaultProcessAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const isProcessAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { return dependencies.isProcessAlive?.(pid) ?? defaultProcessAlive(pid); }
    catch { return true; }
  };
  const git = dependencies.git ?? (async (args, options) => {
    try {
      const result = await executeFile("git", args, { cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8" });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error: unknown) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
    }
  });

  async function ensureLayout(root: string): Promise<void> {
    const paths = workspacePaths(root);
    await Promise.all([mkdir(paths.root, { recursive: true }), mkdir(paths.sourcesDirectory, { recursive: true }), mkdir(paths.runsDirectory, { recursive: true })]);
  }

  async function loadWorkspace(root: string): Promise<WorkspaceDocument> {
    const paths = workspacePaths(root);
    if (!(await pathExists(paths.workspaceFile))) throw new Error(`not a Wiki workspace (missing workspace.yaml under ${paths.root}); run /wiki init`);
    return parseWorkspace(await readText(paths.workspaceFile), "workspace.yaml");
  }

  async function saveWorkspace(root: string, document: WorkspaceDocument): Promise<WorkspaceDocument> {
    const paths = workspacePaths(root);
    const next = { ...document, version: 5 as const, updatedAt: nowIso(now) };
    await writeText(paths.workspaceFile, YAML.stringify(next, { indent: 2, lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }));
    return next;
  }

  async function coreDigest(): Promise<string> { return `sha256:${(await hashTree(path.join(methodSourceDirectory, "..", "..", "dist"))).digest}`; }
  async function methodDigest(): Promise<string> { return `sha256:${(await hashTree(methodSourceDirectory)).digest}`; }

  async function installRuntime(root: string, runtime: WikiRuntimeDefinition): Promise<boolean> {
    const paths = workspacePaths(root);
    const normalized = validateRuntime(runtime);
    const next = {
      version: 1,
      workspaceRoot: paths.root,
      runtime: normalized,
      coreDigest: await coreDigest(),
      methodDigest: await methodDigest(),
      installedAt: nowIso(now),
    };
    const previous = await readJson<typeof next>(paths.runtimeFile);
    if (previous && previous.workspaceRoot === next.workspaceRoot && JSON.stringify(previous.runtime) === JSON.stringify(next.runtime) && previous.coreDigest === next.coreDigest && previous.methodDigest === next.methodDigest) return false;
    await writeJson(paths.runtimeFile, next, uuid());
    return true;
  }

  async function requireRuntime(root: string): Promise<WikiRuntimeDefinition> {
    const paths = workspacePaths(root);
    const runtime = await readJson<{ version: number; workspaceRoot: string; runtime: WikiRuntimeDefinition; coreDigest: string; methodDigest: string }>(paths.runtimeFile);
    if (!runtime || runtime.version !== 1 || runtime.workspaceRoot !== paths.root) throw new Error("runtime manifest is missing or invalid; reinitialize this workspace from the Pi /wiki command");
    if (runtime.coreDigest !== await coreDigest() || runtime.methodDigest !== await methodDigest()) throw new Error("runtime manifest is stale; reinitialize this workspace from the Pi /wiki command");
    return validateRuntime(runtime.runtime);
  }

  async function activeRun(root: string, expectedRunId?: string): Promise<{ paths: ReturnType<typeof runPaths>; state: WikiRunState; meta: RunMeta }> {
    const workspace = workspacePaths(root);
    const pointer = await readJson<CurrentPointer>(workspace.currentRunFile);
    if (!pointer || pointer.version !== 5 || !pointer.runId || (expectedRunId && pointer.runId !== expectedRunId)) throw new Error(expectedRunId ? `active run is not ${expectedRunId}` : "no active run");
    const paths = runPaths(root, pointer.runId);
    const [meta, state] = await Promise.all([readJson<RunMeta>(paths.metaPath), readJson<WikiRunState>(paths.statePath)]);
    if (!meta || meta.version !== 5 || meta.runId !== pointer.runId) throw new Error(`invalid run metadata for ${pointer.runId}`);
    if (!state || state.version !== 5 || state.runId !== pointer.runId || !runStatuses.has(state.status) || !qualityStatuses.has(state.quality?.status)) throw new Error(`invalid run state for ${pointer.runId}`);
    return { paths, state, meta };
  }

  async function saveRunState(paths: ReturnType<typeof runPaths>, state: WikiRunState): Promise<WikiRunState> {
    const next: WikiRunState = { ...state, updatedAt: nowIso(now) };
    await writeJson(paths.statePath, next, uuid());
    return next;
  }

  function isClaimDocument(claim: unknown, runId: string): claim is RunClaimDocument {
    if (!claim || typeof claim !== "object") return false;
    const value = claim as Partial<RunClaimDocument>;
    return value.version === 2
      && value.runId === runId
      && typeof value.orchestrationId === "string"
      && typeof value.pid === "number"
      && Number.isInteger(value.pid)
      && value.pid > 0;
  }

  async function rotateDeadClaim(lockPath: string): Promise<void> {
    const stalePath = `${lockPath}.stale-${uuid()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(stalePath, { force: true });
  }

  async function policy(paths: ReturnType<typeof runPaths>): Promise<RunPolicy> {
    const result = await readJson<RunPolicy>(paths.policyPath);
    if (!result || result.version !== 5) throw new Error(`invalid run policy for ${paths.runId}`);
    return result;
  }

  async function resolveSource(root: string, source: WikiSource): Promise<string> {
    const target = assertInside(root, path.resolve(root, source.path), "source path");
    return realDirectory(target);
  }

  async function sourceHint(directory: string): Promise<string | null> {
    try {
      const names = await readdir(directory);
      return names.includes("pom.xml") || names.some((name) => name.startsWith("build.gradle"))
        ? "Java project detected; defaults include target/, *.class, and .gradle/."
        : null;
    } catch { return null; }
  }

  async function addLinkedSource(root: string, options: { path: string; id?: string; ignore?: string[] }): Promise<WikiSourceSummary> {
    const workspace = await loadWorkspace(root);
    const target = await realDirectory(path.resolve(options.path));
    const id = sourceSlug(options.id ?? path.basename(target));
    if (workspace.sources.some((source) => source.id === id)) throw new Error(`source already exists: ${id}`);
    const paths = workspacePaths(root);
    const destination = path.join(paths.sourcesDirectory, id);
    if (await pathExists(destination)) throw new Error(`destination exists: ${destination}`);
    await mkdir(paths.sourcesDirectory, { recursive: true });
    await symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
    const source: WikiSource = {
      id,
      path: relativePath(root, destination),
      applyDefaultIgnores: workspace.defaultSourceIgnores.enabled,
      ignore: normalizeIgnorePatterns(options.ignore),
      presets: [],
      origin: { type: "path", linkedPath: target, linkType: process.platform === "win32" ? "junction" : "dir" },
    };
    workspace.sources.push(source);
    await saveWorkspace(root, workspace);
    return sourceSummary(source, await effectiveIgnores(source));
  }

  async function addClonedSource(root: string, options: { url: string; id?: string; ref?: string; depth?: number }): Promise<WikiSourceSummary> {
    const workspace = await loadWorkspace(root);
    if (!options.url?.trim()) throw new Error("source URL is required");
    const id = sourceSlug(options.id ?? options.url.replace(/\/$/, "").split("/").pop()?.replace(/\.git$/i, "") ?? "repo");
    if (workspace.sources.some((source) => source.id === id)) throw new Error(`source already exists: ${id}`);
    const destination = path.join(workspacePaths(root).sourcesDirectory, id);
    if (await pathExists(destination)) throw new Error(`destination exists: ${destination}`);
    const temporaryDestination = `${destination}.${uuid()}.tmp`;
    const args = ["clone"];
    if ((options.depth ?? 1) > 0) args.push("--depth", String(options.depth ?? 1));
    if (options.ref) args.push("--branch", options.ref);
    args.push(options.url, temporaryDestination);
    const result = await git(args, { cwd: workspacePaths(root).root, timeoutMs: 120_000 });
    if (result.code !== 0) {
      await rm(temporaryDestination, { recursive: true, force: true });
      throw new Error(`git clone failed: ${result.stderr || result.stdout || result.code}`);
    }
    try { await rename(temporaryDestination, destination); }
    catch (error) { await rm(temporaryDestination, { recursive: true, force: true }); throw error; }
    const source: WikiSource = {
      id,
      path: relativePath(root, destination),
      applyDefaultIgnores: workspace.defaultSourceIgnores.enabled,
      ignore: [],
      presets: [],
      origin: { type: "clone", remoteUrl: options.url, ...(options.ref ? { ref: options.ref } : {}), clonedAt: nowIso(now) },
    };
    workspace.sources.push(source);
    await saveWorkspace(root, workspace);
    return sourceSummary(source, await effectiveIgnores(source));
  }

  async function listSources(root: string): Promise<WikiSourceSummary[]> {
    const workspace = await loadWorkspace(root);
    return Promise.all(workspace.sources.map(async (source) => sourceSummary(source, await effectiveIgnores(source))));
  }

  async function addRequestedSource(root: string, source: Parameters<WikiCore["initializeWorkspace"]>[1]["source"]): Promise<{ source: WikiSourceSummary | null; hint: string | null }> {
    if (!source) return { source: null, hint: null };
    if (source.type === "path") {
      const added = await addLinkedSource(root, { path: source.path, id: source.id, ignore: source.ignore });
      return { source: added, hint: await sourceHint(added.root!) };
    }
    const added = await addClonedSource(root, source);
    return { source: added, hint: await sourceHint(path.resolve(root, added.path)) };
  }

  async function frozenSourceCopy(source: string, destination: string, patterns: string[]): Promise<Array<{ path: string; reason: string }>> {
    const sourceRoot = await realpath(source);
    const skipped: Array<{ path: string; reason: string }> = [];
    const visit = async (fromDirectory: string, relative = ""): Promise<void> => {
      await mkdir(path.join(destination, relative), { recursive: true });
      let entries;
      try { entries = await readdir(fromDirectory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (pathIgnored(childRelative, patterns) || pathIgnored(`${childRelative}/`, patterns)) continue;
        const from = path.join(fromDirectory, entry.name);
        const to = path.join(destination, childRelative);
        if (entry.isDirectory()) await visit(from, childRelative);
        else if (entry.isFile()) await copyRegularFile(from, to);
        else if (entry.isSymbolicLink()) {
          try {
            const target = await realpath(from);
            assertInside(sourceRoot, target, "source symlink");
            if ((await stat(target)).isFile()) await copyRegularFile(target, to);
            else skipped.push({ path: childRelative, reason: "directory symlink not copied" });
          } catch { skipped.push({ path: childRelative, reason: "dangling, unreadable, or escaping symlink" }); }
        }
      }
    };
    await visit(source);
    return skipped;
  }

  async function verifySnapshot(paths: ReturnType<typeof runPaths>): Promise<string[]> {
    const snapshot = await readJson<{ version: number; sources: Array<{ sourceId: string; contentDigest: string }>; methodDigest: string }>(paths.snapshotPath);
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.sources)) return ["snapshot manifest is invalid"];
    const errors: string[] = [];
    for (const source of snapshot.sources) {
      const tree = await hashTree(path.join(paths.sourcesDir, source.sourceId));
      if (`sha256:${tree.digest}` !== source.contentDigest) errors.push(`source digest mismatch: ${source.sourceId}`);
    }
    if (`sha256:${(await hashTree(paths.methodDir)).digest}` !== snapshot.methodDigest) errors.push("method digest mismatch");
    return errors;
  }

  async function parseQuality(paths: ReturnType<typeof runPaths>, ids?: string[]): Promise<{ ok: boolean; reports: QualityReport[]; errors: string[] }> {
    const reports: Array<{ id: string; file: string; final: boolean }> = [
      { id: "coverage", file: paths.coverageReviewPath, final: false },
      ...Object.entries(paths.qualityReportPaths).map(([id, file]) => ({ id, file, final: true })),
    ];
    const selected = ids ? new Set(ids) : undefined;
    const output: QualityReport[] = [];
    const errors: string[] = [];
    for (const report of reports.filter((item) => !selected || selected.has(item.id))) {
      const relative = relativePath(paths.runDir, report.file);
      if (!(await isRegularFile(report.file))) {
        const message = `missing quality report: ${relative}`;
        output.push({ id: report.id, path: relative, valid: false, verdict: null, errors: [message] });
        errors.push(message);
        continue;
      }
      const text = await readText(report.file);
      const field = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:\\s*(.+?)\\s*$`, "im").exec(text)?.[1]?.trim() ?? null;
      const verdict = field("Verdict") as "PASS" | "FAIL" | null;
      const reportErrors: string[] = [];
      if (verdict !== "PASS" && verdict !== "FAIL") reportErrors.push(`${relative}: Verdict must be PASS or FAIL`);
      for (const name of ["Affected pages", "Findings", "Required repair"]) if (!field(name)) reportErrors.push(`${relative}: ${name} must be a non-empty line`);
      if (verdict === "FAIL" && (/^none$/i.test(field("Findings") ?? "") || /^none$/i.test(field("Required repair") ?? ""))) reportErrors.push(`${relative}: FAIL reports must name findings and required repair`);
      if (report.final && verdict !== "PASS") reportErrors.push(`${relative}: final quality report must pass before sealing`);
      output.push({ id: report.id, path: relative, valid: reportErrors.length === 0, verdict, errors: reportErrors });
      errors.push(...reportErrors);
    }
    return { ok: errors.length === 0, reports: output, errors };
  }

  async function requirePlan(paths: ReturnType<typeof runPaths>): Promise<string> {
    if (!(await isRegularFile(paths.planPath))) throw new Error("analysis/plan.md must exist and be non-empty before planning can complete");
    const text = await readText(paths.planPath);
    if (!text.trim()) throw new Error("analysis/plan.md must exist and be non-empty before planning can complete");
    return text;
  }

  async function planQuality(paths: ReturnType<typeof runPaths>): Promise<{ errors: string[]; entries: PageMatrixEntry[] }> {
    const matrix = await parsePageMatrix(paths);
    const errors = [...matrix.errors];
    const reports = await parseQuality(paths, ["coverage", "coverage-rereview"]);
    errors.push(...reports.errors);
    return { errors, entries: matrix.entries };
  }

  async function parsePageMatrix(paths: ReturnType<typeof runPaths>): Promise<{ entries: PageMatrixEntry[]; errors: string[] }> {
    const plan = await requirePlan(paths);
    const errors: string[] = [];
    const lines = plan.split(/\r?\n/);
    const heading = lines.findIndex((line) => /^#{1,6}\s+Page Matrix\s*$/i.test(line));
    if (heading < 0) return { entries: [], errors: ["analysis/plan.md must contain a Page Matrix Markdown table"] };
    const section: string[] = [];
    for (let index = heading + 1; index < lines.length && !/^#{1,6}\s+/.test(lines[index]); index += 1) section.push(lines[index]);
    const rows = section.map(tableRow);
    const headerIndex = rows.findIndex((row) => row !== null);
    if (headerIndex < 0 || !rows[headerIndex + 1]) return { entries: [], errors: ["analysis/plan.md must contain a Page Matrix Markdown table"] };
    const header = rows[headerIndex]!.map((cell) => cell.toLowerCase());
    const separator = rows[headerIndex + 1]!;
    const expectedColumns = ["page", "coverage units", "evidence brief", "diagram"];
    if (expectedColumns.some((column) => !header.includes(column)) || separator.length !== header.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
      return { entries: [], errors: [`Page Matrix must have columns: ${expectedColumns.join(", ")}`] };
    }
    const column = Object.fromEntries(header.map((name, index) => [name, index]));
    const entries: PageMatrixEntry[] = [];
    for (const row of rows.slice(headerIndex + 2)) {
      if (row === null) break;
      if (row.length !== header.length) { errors.push(`Page Matrix row has ${row.length} cells; expected ${header.length}`); continue; }
      const page = row[column.page] ?? "";
      const evidence = row[column["evidence brief"]] ?? "";
      const diagram = (row[column.diagram] ?? "").toLowerCase();
      const coverageUnits = parseCoverageUnits(row[column["coverage units"]] ?? "");
      if (!bundlePagePath(page)) errors.push(`Page Matrix has an invalid bundle-relative page: ${page || "(empty)"}`);
      if (!coverageUnits.length) errors.push(`Page Matrix ${page || "row"} must name at least one coverage unit`);
      if (!(diagram === "required" || diagram === "useful" || diagram === "omitted")) errors.push(`Page Matrix ${page || "row"} diagram must be required, useful, or omitted`);
      if (!evidence.startsWith("analysis/evidence/") || evidence.includes("\\") || evidence.split("/").includes("..")) errors.push(`Page Matrix ${page || "row"} evidence brief must be under analysis/evidence/: ${evidence || "(empty)"}`);
      else {
        const evidencePath = path.resolve(paths.runDir, evidence);
        try {
          assertInside(paths.evidenceDir, evidencePath, "evidence brief");
          const text = await readText(evidencePath);
          if (!text.trim()) errors.push(`Page Matrix ${page || "row"} evidence brief is empty: ${evidence}`);
          if (!/inputs\/sources\/[^\s)#]+#L\d+(?:-L\d+)?/.test(text)) errors.push(`Page Matrix ${page || "row"} evidence brief has no frozen-source citation: ${evidence}`);
        } catch { errors.push(`Page Matrix ${page || "row"} evidence brief is missing: ${evidence}`); }
      }
      entries.push({ page, evidence, coverageUnits, diagram: diagram as PageMatrixEntry["diagram"] });
    }
    if (!entries.length) errors.push("Page Matrix must contain at least one page row");
    const duplicatePages = entries.filter((entry, index) => entry.page && entries.findIndex((candidate) => candidate.page === entry.page) !== index).map((entry) => entry.page);
    if (duplicatePages.length) errors.push(`Page Matrix contains duplicate page rows: ${[...new Set(duplicatePages)].join(", ")}`);
    const inventory = await readJson<Inventory>(paths.inventoryPath);
    const covered = new Set(entries.flatMap((entry) => entry.coverageUnits));
    const missing = inventory?.coverageUnits.filter((unit) => unit.required && !covered.has(unit.id)).map((unit) => unit.id) ?? [];
    if (missing.length) errors.push(`Page Matrix does not cover required units: ${missing.join(", ")}`);
    return { entries, errors };
  }

  function normalizeMainSessionPath(paths: ReturnType<typeof runPaths>, value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!value) throw new Error("mainSessionPath must be a non-empty path under analysis/session");
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(paths.runDir, value);
    assertInside(paths.mainSessionDir, absolute, "mainSessionPath");
    return relativePath(paths.runDir, absolute);
  }

  function statusForResume(resumeAt: ResumeAt): RunStatus { return resumeAt === "write" ? "writing" : "planning"; }
  async function qualitySnapshot(paths: ReturnType<typeof runPaths>, state: WikiRunState, extra: string[] = []): Promise<RunQuality> {
    const reports = await parseQuality(paths);
    return { status: reports.errors.length || extra.length ? "blocked" : "passed", recoveryCount: state.quality.recoveryCount, reports: reports.reports, errors: [...reports.errors, ...extra], checkedAt: nowIso(now) };
  }

  async function blockForQuality(paths: ReturnType<typeof runPaths>, state: WikiRunState, errors: string[]): Promise<WikiRunState> {
    return saveRunState(paths, { ...state, status: "quality_blocked", quality: await qualitySnapshot(paths, state, errors) });
  }

  async function stampAndIndex(paths: ReturnType<typeof runPaths>): Promise<{ errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!(await pathExists(paths.bundleDir))) { errors.push("bundle directory is missing"); return { errors, warnings }; }
    const matrix = await parsePageMatrix(paths);
    errors.push(...matrix.errors);
    const markdown: Array<{ absolute: string; relative: string }> = [];
    const walk = async (directory: string, relative = ""): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { errors.push(`${childRelative}: symlinks are not allowed in bundle/`); continue; }
        if (entry.isDirectory()) await walk(child, childRelative);
        else if (entry.isFile() && entry.name.endsWith(".md")) markdown.push({ absolute: child, relative: childRelative });
      }
    };
    await walk(paths.bundleDir);
    const pages = markdown.filter((item) => path.posix.basename(item.relative) !== "index.md");
    if (!pages.length) warnings.push("bundle has no concept or domain pages yet");
    for (const page of pages) {
      const text = await readText(page.absolute);
      if (!text.startsWith("---\n")) { errors.push(`${page.relative}: missing YAML frontmatter`); continue; }
      const end = text.indexOf("\n---", 4);
      if (end < 0) { errors.push(`${page.relative}: invalid YAML frontmatter`); continue; }
      const frontmatter = YAML.parse(text.slice(4, end)) as Record<string, unknown>;
      if (!frontmatter || typeof frontmatter.type !== "string" || typeof frontmatter.title !== "string" || !Array.isArray(frontmatter.sources) || !frontmatter.sources.length) {
        errors.push(`${page.relative}: frontmatter requires type, title, and sources`);
        continue;
      }
      if (!bundlePagePath(page.relative)) errors.push(`${page.relative}: must be under domains/<domain>/ or concepts/`);
      const matrixEntry = matrix.entries.find((entry) => entry.page === page.relative);
      if (!matrixEntry) errors.push(`${page.relative}: page is not declared in the Page Matrix`);
      const resourceIds = new Set<string>();
      const resources = new Set<string>();
      for (const entry of frontmatter.sources) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push(`${page.relative}: sources entries must be mappings`); continue; }
        const { id, resource } = entry as { id?: unknown; resource?: unknown };
        if (typeof id !== "string" || !id.trim()) { errors.push(`${page.relative}: source id must be a non-empty string`); }
        else if (resourceIds.has(id)) errors.push(`${page.relative}: duplicate source id: ${id}`);
        else resourceIds.add(id);
        const location = typeof resource === "string" ? /^(inputs\/sources\/[^#\\]+)#L(\d+)(?:-L(\d+))?$/.exec(resource) : null;
        if (!location || location[1].split("/").includes("..")) {
          errors.push(`${page.relative}: source resource must be run-relative under inputs/sources/`);
          continue;
        }
        const sourceResource = resource as string;
        if (resources.has(sourceResource)) errors.push(`${page.relative}: duplicate source resource: ${sourceResource}`);
        resources.add(sourceResource);
        const start = Number(location[2]);
        const end = Number(location[3] ?? location[2]);
        if (start < 1 || end < start) { errors.push(`${page.relative}: source resource has an invalid line range: ${resource}`); continue; }
        const file = path.resolve(paths.runDir, location[1]);
        try {
          assertInside(paths.sourcesDir, file, "source resource");
          if (!(await isRegularFile(file))) errors.push(`${page.relative}: source resource is missing: ${resource}`);
          else if ((await readText(file)).split(/\r?\n/).length < end) errors.push(`${page.relative}: source resource line range exceeds file: ${resource}`);
        }
        catch { errors.push(`${page.relative}: source resource must be run-relative under inputs/sources/`); }
      }
      frontmatter.status = "draft";
      frontmatter.generated = { by: "okf-wiki-agent/0.1.0", at: nowIso(now) };
      const body = text.slice(end + 4).replace(/^\r?\n/, "");
      const fences = mermaidFences(body);
      for (const fence of fences) {
        if (!fence.closed) errors.push(`${page.relative}: Mermaid fence opened on line ${fence.line} is not closed`);
        else {
          const issue = mermaidError(fence.body);
          if (issue) errors.push(`${page.relative}: Mermaid fence on line ${fence.line} is invalid: ${issue}`);
        }
      }
      if (matrixEntry?.diagram === "required" && !fences.length) errors.push(`${page.relative}: Page Matrix requires a Mermaid diagram`);
      if (matrixEntry?.diagram === "omitted" && fences.length) errors.push(`${page.relative}: Page Matrix marks Mermaid as omitted but the page contains a diagram`);
      const citations = [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
      const sourceCitations = citations.filter((target) => /#L\d+(?:-L\d+)?$/.test(target));
      if (!sourceCitations.length) errors.push(`${page.relative}: page has no frozen-source Markdown citation with #Lx-Ly`);
      for (const citation of sourceCitations) {
        const sourceFile = path.resolve(path.dirname(page.absolute), citation.split("#", 1)[0]);
        try { assertInside(paths.sourcesDir, sourceFile, "citation"); if (!(await isRegularFile(sourceFile))) errors.push(`${page.relative}: frozen-source citation is missing: ${citation}`); }
        catch { errors.push(`${page.relative}: citation must resolve under inputs/sources/: ${citation}`); }
      }
      for (const target of citations.filter((candidate) => !sourceCitations.includes(candidate))) {
        if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const location = target.split("#", 1)[0];
        const targetFile = path.resolve(path.dirname(page.absolute), location);
        try {
          assertInside(paths.bundleDir, targetFile, "internal link");
          if (!(await isRegularFile(targetFile))) errors.push(`${page.relative}: internal link target is missing: ${target}`);
        } catch { errors.push(`${page.relative}: internal link escapes bundle/: ${target}`); }
      }
      await writeText(page.absolute, `---\n${YAML.stringify(frontmatter, { indent: 2, lineWidth: 0 }).trimEnd()}\n---\n\n${body}`);
    }
    for (const entry of matrix.entries) if (!pages.some((page) => page.relative === entry.page)) errors.push(`Page Matrix declares a page that was not written: ${entry.page}`);
    if (errors.length) return { errors, warnings };
    const index = async (directory: string, relative = ""): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => !entry.name.startsWith(".")).sort((left, right) => left.name.localeCompare(right.name));
      const directories = entries.filter((entry) => entry.isDirectory());
      for (const entry of directories) await index(path.join(directory, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
      if (!relative) await writeText(path.join(directory, "index.md"), '---\nokf_version: "0.2"\n---\n\n# Wiki\n');
      else {
        const pages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md");
        const lines = ["# Index", ""];
        if (directories.length) lines.push("## Directories", "", ...directories.map((entry) => `- [${entry.name}/](./${entry.name}/index.md)`), "");
        if (pages.length) lines.push("## Pages", "", ...pages.map((entry) => `- [${entry.name.replace(/\.md$/, "")}](./${entry.name})`), "");
        await writeText(path.join(directory, "index.md"), `${lines.join("\n")}\n`);
      }
    };
    await index(paths.bundleDir);
    return { errors, warnings };
  }

  return {
    async initializeWorkspace(root, options) {
      const paths = workspacePaths(root);
      await ensureLayout(paths.root);
      const exists = await pathExists(paths.workspaceFile);
      if (exists && !options.force) {
        const runtimeInstalled = await installRuntime(paths.root, options.runtime);
        const added = await addRequestedSource(paths.root, options.source);
        const workspace = await status(paths.root);
        return { ok: true, created: false, workspace, runtimeInstalled, ...added };
      }
      if (options.force) await Promise.all([
        rm(paths.metadataDirectory, { recursive: true, force: true }),
        rm(paths.sourcesDirectory, { recursive: true, force: true }),
      ]);
      await ensureLayout(paths.root);
      const document = defaultWorkspace(paths.root, nowIso(now), uuid, options.name, options.wikiLanguage ?? "en");
      await saveWorkspace(paths.root, document);
      const runtimeInstalled = await installRuntime(paths.root, options.runtime);
      const added = await addRequestedSource(paths.root, options.source);
      return { ok: true, created: true, workspace: await status(paths.root), runtimeInstalled, ...added };
    },
    async getWorkspaceStatus(root) { return status(root); },
    addClonedSource,
    addLinkedSource,
    async removeSource(root, sourceIdValue) {
      const workspace = await loadWorkspace(root);
      const id = requireSourceId(sourceIdValue);
      const source = workspace.sources.find((candidate) => candidate.id === id);
      if (!source) throw new Error(`unknown source: ${id}`);
      const paths = workspacePaths(root);
      const target = assertInside(paths.sourcesDirectory, path.join(paths.sourcesDirectory, id), "source path");
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) await unlink(target);
        else await rm(target, { recursive: true, force: true });
      } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await saveWorkspace(root, { ...workspace, sources: workspace.sources.filter((candidate) => candidate.id !== id) });
      return { removed: id };
    },
    listSources,
    async prepareRun(root, options = {}): Promise<RunPreparation> {
      const workspace = await loadWorkspace(root);
      if (!workspace.sources.length) throw new Error("workspace has no sources; add a source with /wiki source add clone|path");
      if (options.focus !== undefined && !options.focus.trim()) throw new Error("focus must be a non-empty string when provided");
      try {
        const active = await activeRun(root);
        if (!options.focus && !["complete", "stopped"].includes(active.state.status) && !(await pathExists(active.paths.manifestPath))) return resume(active.paths, active.state);
      } catch (error: unknown) { if (!(error as Error).message.includes("no active run")) throw error; }
      const runtime = await requireRuntime(root);
      const id = `${uuid().slice(0, 8)}${now().getTime().toString(36).slice(-4)}`;
      const paths = runPaths(root, id);
      await Promise.all([mkdir(paths.sourcesDir, { recursive: true }), mkdir(paths.discoveryDir, { recursive: true }), mkdir(paths.evidenceDir, { recursive: true }), mkdir(paths.qualityReportsDir, { recursive: true }), mkdir(paths.mainSessionDir, { recursive: true }), mkdir(paths.bundleDir, { recursive: true })]);
      await copyDirectory(methodSourceDirectory, paths.methodDir);
      const snapshots: Array<{ sourceId: string; contentDigest: string; fileCount: number; files: unknown[]; gitHead: string | null; skippedSymlinks: unknown[] }> = [];
      const inventorySources: Array<{ id: string; root: string; patterns: string[] }> = [];
      for (const source of workspace.sources) {
        const original = await resolveSource(root, source);
        const patterns = await effectiveIgnores(source);
        const destination = path.join(paths.sourcesDir, source.id);
        const skippedSymlinks = await frozenSourceCopy(original, destination, patterns);
        const tree = await hashTree(destination);
        const head = await git(["rev-parse", "HEAD"], { cwd: original, timeoutMs: 5_000 });
        snapshots.push({ sourceId: source.id, contentDigest: `sha256:${tree.digest}`, fileCount: tree.fileCount, files: tree.files, gitHead: head.code === 0 ? head.stdout.trim() : null, skippedSymlinks });
        inventorySources.push({ id: source.id, root: destination, patterns });
      }
      const inventory = await buildInventory(inventorySources, workspace.wikiLanguage, nowIso(now));
      const discovery = { enabled: inventory.coverageUnits.length > 12 || workspace.sources.length > 4, maxAgents: inventory.coverageUnits.length > 12 || workspace.sources.length > 4 ? 3 : 0 };
      const method = `sha256:${(await hashTree(paths.methodDir)).digest}`;
      const currentTime = nowIso(now);
      const state: WikiRunState = { version: 5, runId: id, status: "planning", resumeAt: discovery.enabled ? "discover" : "plan", approval: workspace.workflow.approval, planDigest: null, approvedAt: null, mainSessionPath: null, bundle: null, quality: { status: "pending", recoveryCount: 0, reports: [], errors: [] }, createdAt: currentTime, updatedAt: currentTime };
      const runPolicy: RunPolicy = { version: 5, focus: options.focus?.trim() || null, discovery, runtime, methodDigest: method };
      await Promise.all([
        writeJson(paths.snapshotPath, { version: 1, sources: snapshots, methodDigest: method }, uuid()),
        writeJson(paths.inventoryPath, inventory, uuid()),
        writeJson(paths.policyPath, runPolicy, uuid()),
        writeText(path.join(paths.analysisDir, "inventory.md"), inventoryMarkdown(inventory)),
        writeJson(paths.statePath, state, uuid()),
        writeJson(paths.metaPath, { version: 5, runId: id, createdAt: currentTime, focus: runPolicy.focus }, uuid()),
      ]);
      // Publish only after every immutable artifact and the durable state are available.
      await writeJson(workspacePaths(root).currentRunFile, { version: 5, runId: id }, uuid());
      return { ...publicPaths(paths), state, resumeAt: state.resumeAt, adaptiveDiscovery: discovery };
    },
    async recordMainSession(root, options): Promise<WikiRunState> {
      const { paths, state } = await activeRun(root, options.runId);
      if (["complete", "stopped"].includes(state.status)) throw new Error(`run ${state.runId} is terminal`);
      const mainSessionPath = normalizeMainSessionPath(paths, options.mainSessionPath);
      if (!mainSessionPath) throw new Error("mainSessionPath must be a non-empty path under analysis/session");
      return state.mainSessionPath === mainSessionPath ? state : saveRunState(paths, { ...state, mainSessionPath });
    },
    async completeRunPlanning(root, options): Promise<RunPlanningCompletion> {
      const { paths, state } = await activeRun(root, options.runId);
      if (state.status !== "planning" && state.status !== "proposed") throw new Error(`run ${state.runId} is not planning`);
      const snapshotErrors = await verifySnapshot(paths);
      if (snapshotErrors.length) throw new Error(`frozen snapshot integrity failed: ${snapshotErrors.join("; ")}`);
      const planning = await planQuality(paths);
      if (planning.errors.length) throw new Error(`plan quality gate failed: ${planning.errors.join("; ")}`);
      const planDigest = `sha256:${await hashFile(paths.planPath)}`;
      const next = await saveRunState(paths, { ...state, status: state.approval === "propose" ? "proposed" : "writing", resumeAt: "write", planDigest });
      return { ...publicPaths(paths), state: next, planDigest, requiresApproval: next.status === "proposed", resumeAt: next.resumeAt };
    },
    async approveRun(root, options): Promise<RunPlanningCompletion> {
      const { paths, state } = await activeRun(root, options.runId);
      if (state.approval !== "propose" || state.status !== "proposed") throw new Error(`run ${state.runId} does not have a proposed plan awaiting approval`);
      const snapshotErrors = await verifySnapshot(paths);
      if (snapshotErrors.length) throw new Error(`frozen snapshot integrity failed: ${snapshotErrors.join("; ")}`);
      const planDigest = `sha256:${await hashFile(paths.planPath)}`;
      if (planDigest !== state.planDigest || (options.planDigest && options.planDigest !== planDigest)) throw new Error("plan changed after proposal; complete planning again before approval");
      const next = await saveRunState(paths, { ...state, status: "writing", resumeAt: "write", approvedAt: nowIso(now) });
      return { ...publicPaths(paths), state: next, planDigest, requiresApproval: false, resumeAt: "write" };
    },
    async resumeRun(root, options): Promise<RunResumption> {
      const { paths, state } = await activeRun(root, options.runId);
      return resume(paths, state);
    },
    async reportRunStatus(root, options): Promise<WikiRunState> {
      const { paths, state } = await activeRun(root, options.runId);
      if (["complete", "stopped"].includes(state.status)) throw new Error(`run ${state.runId} is terminal`);
      return saveRunState(paths, { ...state, status: options.status, ...(options.error === undefined ? {} : { error: String(options.error) }) });
    },
    async validateRunBundle(root, options): Promise<RunValidationResult> {
      const { paths, state } = await activeRun(root, options.runId);
      const existing = await readJson<BundleManifest>(paths.manifestPath);
      if (existing) {
        const tree = await hashTree(paths.bundleDir);
        if (existing.version !== 1 || existing.bundleDigest !== `sha256:${tree.digest}`) throw new Error("sealed bundle was modified; create a new run");
        return { ...publicPaths(paths), ok: true, alreadySealed: true, errors: [], warnings: [], state, status: "complete" };
      }
      if (state.status !== "writing" && state.status !== "validating") throw new Error(`run ${state.runId} is not ready to validate`);
      const reports = await parseQuality(paths);
      if (!reports.ok) {
        const blocked = await blockForQuality(paths, state, reports.errors);
        return { ...publicPaths(paths), ok: false, errors: reports.errors, warnings: [], state: blocked, status: blocked.status };
      }
      const validating = await saveRunState(paths, { ...state, status: "validating" });
      const bundle = await stampAndIndex(paths);
      if (bundle.errors.length) {
        const blocked = await blockForQuality(paths, validating, bundle.errors);
        return { ...publicPaths(paths), ok: false, errors: bundle.errors, warnings: bundle.warnings, state: blocked, status: blocked.status };
      }
      const tree = await hashTree(paths.bundleDir);
      const manifest: BundleManifest = { version: 1, bundleDigest: `sha256:${tree.digest}`, sealedAt: nowIso(now) };
      await writeJson(paths.manifestPath, manifest, uuid());
      const complete = await saveRunState(paths, { ...validating, status: "complete", bundle: { digest: manifest.bundleDigest, sealedAt: manifest.sealedAt }, quality: await qualitySnapshot(paths, validating) });
      return { ...publicPaths(paths), ok: true, errors: [], warnings: bundle.warnings, state: complete, status: "complete" };
    },
    async getRunPaths(root, options) { return publicPaths((await activeRun(root, options.runId)).paths); },
    async getRunState(root, options) { return (await activeRun(root, options.runId)).state; },
    async getRunQuality(root, options) { const active = await activeRun(root, options.runId); return qualitySnapshot(active.paths, active.state); },
    async claimRun(root, options) {
      const { paths, state } = await activeRun(root, options.runId);
      if (["complete", "stopped"].includes(state.status)) throw new Error(`run ${state.runId} is terminal and cannot be claimed`);
      if (!options.orchestrationId?.trim() || options.orchestrationId.length > 256) throw new Error("orchestrationId must be a non-empty string up to 256 characters");
      const orchestrationId = options.orchestrationId.trim();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const claim: RunClaimDocument = { version: 2, runId: state.runId, orchestrationId, pid: process.pid, claimedAt: nowIso(now) };
        try {
          await writeExclusiveJson(paths.lockPath, claim, uuid());
          return { claimed: true, orchestrationId };
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const existing = await readJson<RunClaimDocument>(paths.lockPath);
        if (!isClaimDocument(existing, state.runId)) throw new Error(`run ${state.runId} has an invalid lock`);
        if (isProcessAlive(existing.pid)) {
          throw new Error(`run ${state.runId} is already claimed by ${existing.orchestrationId}`);
        }
        await rotateDeadClaim(paths.lockPath);
      }
      throw new Error(`could not acquire run ${state.runId} lock after stale-lock recovery`);
    },
    async releaseRun(root, options) {
      const { paths, state } = await activeRun(root, options.runId);
      const claim = await readJson<RunClaimDocument>(paths.lockPath);
      if (!claim) return { released: false };
      if (!isClaimDocument(claim, state.runId) || claim.orchestrationId !== options.orchestrationId || claim.pid !== process.pid) throw new Error(`run ${state.runId} lock is not owned by ${options.orchestrationId}`);
      await rm(paths.lockPath);
      return { released: true };
    },
  };

  async function resume(paths: ReturnType<typeof runPaths>, state: WikiRunState): Promise<RunResumption> {
    if (state.status === "complete") throw new Error("run is complete; create a new run");
    if (state.status === "stopped") throw new Error("run was stopped; create a new run");
    if (state.status === "proposed") throw new Error("run has a proposed plan; use /wiki approve before resuming");
    const snapshotErrors = await verifySnapshot(paths);
    if (snapshotErrors.length) throw new Error(`frozen snapshot integrity failed: ${snapshotErrors.join("; ")}`);
    let next = state;
    let qualityRecovery = false;
    if (state.status === "quality_blocked") {
      if (state.quality.recoveryCount >= 1) throw new Error("quality repair limit reached; inspect reports and create a new run");
      const reports = await parseQuality(paths);
      next = await saveRunState(paths, { ...state, status: "writing", resumeAt: "write", quality: { status: "repairing", recoveryCount: state.quality.recoveryCount + 1, reports: reports.reports, errors: reports.errors, resumedAt: nowIso(now) } });
      qualityRecovery = true;
    } else if (state.status === "paused" || state.status === "failed") {
      next = await saveRunState(paths, { ...state, status: statusForResume(state.resumeAt), error: undefined });
    }
    const runPolicy = await policy(paths);
    return { ...publicPaths(paths), state: next, resumeAt: next.resumeAt, adaptiveDiscovery: runPolicy.discovery, qualityRecovery };
  }

  async function status(root: string): Promise<WikiWorkspaceStatus> {
    const workspace = await loadWorkspace(root);
    const summaries = await listSources(root);
    let active: (WikiRunPaths & { status: RunStatus }) | null = null;
    let activeRunId: string | undefined;
    let runs: WikiWorkspaceStatus["runs"] = [];
    const paths = workspacePaths(root);
    const pointer = await readJson<CurrentPointer>(paths.currentRunFile);
    if (pointer?.version === 5) {
      try {
        const current = await activeRun(root);
        activeRunId = current.state.runId;
        active = { ...publicPaths(current.paths), status: current.state.status };
      } catch { /* current pointer is ignored when its run is corrupt */ }
    }
    if (await pathExists(paths.runsDirectory)) {
      const entries = await readdir(paths.runsDirectory, { withFileTypes: true });
      runs = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const run = runPaths(root, entry.name);
        const [meta, state] = await Promise.all([readJson<RunMeta>(run.metaPath), readJson<WikiRunState>(run.statePath)]);
        return meta && state && meta.version === 5 && state.version === 5 ? { runId: meta.runId, createdAt: meta.createdAt, status: state.status, focus: meta.focus } : null;
      }))).filter((run): run is NonNullable<typeof run> => run !== null).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 10);
    }
    return { root: paths.root, initialized: true, name: workspace.name, wikiLanguage: workspace.wikiLanguage, approval: workspace.workflow.approval, ...(activeRunId ? { activeRunId } : {}), sources: summaries, runtime: "pi", active, runs };
  }
}

function publicPaths(paths: ReturnType<typeof runPaths>): WikiRunPaths {
  const { lockPath: _lockPath, policyPath: _policyPath, inventoryPath: _inventoryPath, snapshotPath: _snapshotPath, manifestPath: _manifestPath, metaPath: _metaPath, ...publicFields } = paths;
  return publicFields;
}

function markdownCell(value: string): string { return value.trim().replace(/^`(.+)`$/, "$1").trim(); }

function tableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(markdownCell);
}

function parseCoverageUnits(value: string): string[] {
  const code = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
  return code.length ? code : value.split(/[,;]/).map(markdownCell).filter((item) => item && !/^none$/i.test(item));
}

function bundlePagePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..") || !value.endsWith(".md")) return false;
  return /^concepts\/[^/]+\.md$/.test(value) || /^domains\/[^/]+\/(?:overview|[^/]+)\.md$/.test(value);
}

function mermaidFences(markdown: string): Array<{ line: number; body: string; closed: boolean }> {
  const result: Array<{ line: number; body: string; closed: boolean }> = [];
  let open: { marker: string; line: number; body: string[] } | undefined;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const fence = /^(\s*)(`{3,})\s*(\S*)\s*$/.exec(line);
    if (open) {
      if (fence && fence[2].length >= open.marker.length && !fence[3]) { result.push({ line: open.line, body: open.body.join("\n"), closed: true }); open = undefined; }
      else open.body.push(line);
    } else if (fence?.[3].toLowerCase() === "mermaid") open = { marker: fence[2], line: index + 1, body: [] };
  }
  if (open) result.push({ line: open.line, body: open.body.join("\n"), closed: false });
  return result;
}

function mermaidError(body: string): string | undefined {
  const directive = body.trim().split(/\s+/)[0]?.toLowerCase();
  if (!directive) return "diagram is empty";
  if (!new Set(["flowchart", "graph", "sequencediagram", "classdiagram", "statediagram", "erdiagram", "journey", "gantt", "pie", "mindmap", "timeline", "quadrantchart", "requirementdiagram", "gitgraph", "xychart-beta"]).has(directive)) return `unknown Mermaid diagram directive: ${directive}`;
  if ((directive === "flowchart" || directive === "graph") && (/(?:^|\n|\s)end\s*[[({]/.test(body) || /-->\s*end\s*(?:$|\n|;)/m.test(body))) return "flowchart uses reserved word `end` as a node id";
  if (/[[({][^)\]}]*;[^)\]}]*[)\]}]/.test(body)) return "diagram contains a semicolon inside a label";
  return undefined;
}

function inventoryMarkdown(inventory: Inventory): string {
  const lines = ["# Repository Inventory", "", `- Tier: ${inventory.tier}`, `- Sources: ${inventory.sourceCount}`, `- Files: ${inventory.fileCount}`, "", "## Required Coverage", ""];
  for (const unit of inventory.coverageUnits) lines.push(`- \`${unit.id}\` (${unit.kind}, \`${unit.sourceId}/${unit.path}\`)`);
  return `${lines.join("\n")}\n`;
}

async function writeExclusiveJson(file: string, value: unknown, id: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${id}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await link(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
