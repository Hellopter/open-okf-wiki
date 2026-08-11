import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_WIKI_WORKFLOW_POLICY } from "./policy.js";
import { ensureWikiWorkspaceInternalIgnore } from "./workspace.js";

export const MAX_WIKI_RESEARCH_ARTIFACT_BYTES = DEFAULT_WIKI_WORKFLOW_POLICY.artifacts.researchBytes;
/** Limit for model-authored synthesis and review JSON handoffs. */
export const MAX_WIKI_JSON_ARTIFACT_BYTES = DEFAULT_WIKI_WORKFLOW_POLICY.artifacts.controlBytes;
/** Limit for deterministic coordinator artifacts. */
export const MAX_WIKI_ARTIFACT_BYTES = DEFAULT_WIKI_WORKFLOW_POLICY.artifacts.maxBytes;

export type WikiArtifactKind = "inspection" | "research" | "synthesis" | "write_report" | "validation" | "review" | "finalization";

export interface WikiArtifactRef {
  version: 1;
  runId: string;
  nodeId: string;
  attempt: number;
  kind: WikiArtifactKind;
  /** Workspace-relative, POSIX path suitable for durable metadata. */
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mediaType: "text/markdown" | "application/json";
}

export interface WikiArtifactLocation {
  runId: string;
  nodeId: string;
  attempt: number;
  kind: WikiArtifactKind;
}

export interface WikiArtifactWrite extends WikiArtifactLocation {
  content: string;
}

export interface WikiArtifactStore {
  prepare(location: WikiArtifactLocation): Promise<string>;
  write(input: WikiArtifactWrite): Promise<WikiArtifactRef>;
  finalize(location: WikiArtifactLocation): Promise<WikiArtifactRef>;
  read(ref: WikiArtifactRef): Promise<string>;
  resolve(ref: WikiArtifactRef): string;
  list(runId: string, nodeId: string, attempt: number): Promise<WikiArtifactRef[]>;
  copyRun(sourceRunId: string, targetRunId: string): Promise<WikiArtifactRef[]>;
  removeRun(runId: string): Promise<boolean>;
  getRunsRoot(): string;
}

export interface WikiArtifactStoreOptions {
  workspace: string;
  /** Test seam. Defaults to <workspace>/.okf-wiki/runs. */
  rootDir?: string;
  maxBytes?: number;
}

interface WikiArtifactManifest {
  version: 1;
  artifacts: WikiArtifactRef[];
}

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_KINDS = new Set<WikiArtifactKind>(["inspection", "research", "synthesis", "write_report", "validation", "review", "finalization"]);
const MANIFEST_FILE = "manifest.json";

/**
 * Stores durable agent handoffs below the workspace while keeping snapshots
 * pointer-only. Artifact writes are UTF-8, size bounded, hashed, and renamed
 * atomically before a manifest is updated.
 */
export function createWikiArtifactStore(options: WikiArtifactStoreOptions): WikiArtifactStore {
  const workspace = path.resolve(options.workspace);
  const runsRoot = path.resolve(options.rootDir ?? path.join(workspace, ".okf-wiki", "runs"));
  const configuredMaxBytes = options.maxBytes === undefined ? undefined : positiveInt(options.maxBytes, MAX_WIKI_ARTIFACT_BYTES);
  const limitFor = (kind: WikiArtifactKind): number => Math.min(configuredMaxBytes ?? Number.POSITIVE_INFINITY, artifactSizeLimit(kind));
  const shouldEnsureWorkspaceIgnore = runsRoot === path.join(workspace, ".okf-wiki", "runs");
  let writeChain = Promise.resolve();
  let ignoredReady: Promise<void> | undefined;

  const ensureIgnored = (): Promise<void> => {
    ignoredReady ??= shouldEnsureWorkspaceIgnore ? ensureWikiWorkspaceInternalIgnore(workspace) : Promise.resolve();
    return ignoredReady;
  };

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    let result: T | undefined;
    const next = writeChain.catch(() => {}).then(async () => {
      result = await operation();
    });
    writeChain = next;
    await next;
    return result!;
  };

  const absoluteFor = (location: WikiArtifactLocation): string => {
    assertLocation(location);
    return path.join(runsRoot, location.runId, location.nodeId, attemptDirectoryName(location.attempt), artifactFileName(location.kind));
  };

  const nodeDirectory = (runId: string, nodeId: string): string => {
    assertComponent(runId, "run ID");
    assertComponent(nodeId, "node ID");
    return path.join(runsRoot, runId, nodeId);
  };

  const attemptDirectory = (location: Pick<WikiArtifactLocation, "runId" | "nodeId" | "attempt">): string => {
    const directory = nodeDirectory(location.runId, location.nodeId);
    assertAttempt(location.attempt);
    return path.join(directory, attemptDirectoryName(location.attempt));
  };

  const refFor = (location: WikiArtifactLocation, bytes: Buffer): WikiArtifactRef => ({
    version: 1,
    runId: location.runId,
    nodeId: location.nodeId,
    attempt: location.attempt,
    kind: location.kind,
    relativePath: relativePathFor(location),
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: artifactMediaType(location.kind),
  });

  const write = async (input: WikiArtifactWrite): Promise<WikiArtifactRef> => await enqueue(async () => {
    await ensureIgnored();
    const file = absoluteFor(input);
    const bytes = Buffer.from(input.content, "utf8");
    assertSize(bytes, limitFor(input.kind));
    await ensureSafeArtifactDirectory(runsRoot, path.dirname(file));
    await assertNoArtifactSymlinks(runsRoot, file);
    await writeAtomic(file, bytes);
    const ref = refFor(input, bytes);
    await writeManifest(attemptDirectory(input), ref);
    return ref;
  });

  const read = async (ref: WikiArtifactRef): Promise<string> => {
    const location = locationFromRef(ref);
    const bytes = await readUtf8Bytes(runsRoot, absoluteFor(location), limitFor(location.kind));
    if (bytes.byteLength !== ref.sizeBytes || sha256(bytes) !== ref.sha256) {
      throw new Error(`Wiki handoff artifact integrity check failed: ${ref.relativePath}`);
    }
    return decodeUtf8(bytes);
  };

  return {
    async prepare(location): Promise<string> {
      await ensureIgnored();
      const file = absoluteFor(location);
      await ensureSafeArtifactDirectory(runsRoot, path.dirname(file));
      return relativePathFor(location);
    },

    write,

    async finalize(location): Promise<WikiArtifactRef> {
      const file = absoluteFor(location);
      let bytes: Buffer;
      try {
        bytes = await readUtf8Bytes(runsRoot, file, limitFor(location.kind));
      } catch (error) {
        if (isMissing(error)) throw new Error(`Required ${location.kind} handoff artifact is missing: ${file}`);
        throw error;
      }
      return await write({ ...location, content: decodeUtf8(bytes) });
    },

    read,

    resolve(ref): string {
      const location = locationFromRef(ref);
      const expectedRelative = relativePathFor(location);
      if (ref.relativePath !== expectedRelative) throw new Error("Wiki handoff artifact has an invalid relative path");
      return expectedRelative;
    },

    async list(runId, nodeId, attempt): Promise<WikiArtifactRef[]> {
      await writeChain.catch(() => {});
      return await readManifest(runsRoot, attemptDirectory({ runId, nodeId, attempt }));
    },

    async copyRun(sourceRunId, targetRunId): Promise<WikiArtifactRef[]> {
      assertComponent(sourceRunId, "run ID");
      assertComponent(targetRunId, "run ID");
      const sourceDirectory = path.join(runsRoot, sourceRunId);
      let entries;
      try {
        await assertNoArtifactSymlinks(runsRoot, sourceDirectory);
        entries = await readdir(sourceDirectory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const copied: WikiArtifactRef[] = [];
      for (const node of entries) {
        if (!node.isDirectory() || !SAFE_COMPONENT.test(node.name)) continue;
        const sourceNodeDirectory = nodeDirectory(sourceRunId, node.name);
        await assertNoArtifactSymlinks(runsRoot, sourceNodeDirectory);
        const attempts = await readdir(sourceNodeDirectory, { withFileTypes: true });
        for (const attempt of attempts) {
          const attemptNumber = attemptNumberFromDirectory(attempt.name);
          if (!attempt.isDirectory() || attemptNumber === undefined) continue;
          const refs = await readManifest(runsRoot, path.join(sourceNodeDirectory, attempt.name));
          for (const ref of refs) {
            const content = await read(ref);
            copied.push(await write({ runId: targetRunId, nodeId: ref.nodeId, attempt: ref.attempt, kind: ref.kind, content }));
          }
        }
      }
      return copied;
    },

    async removeRun(runId): Promise<boolean> {
      assertComponent(runId, "run ID");
      let removed = false;
      await enqueue(async () => {
        try {
          await assertNoArtifactSymlinks(runsRoot, path.join(runsRoot, runId));
          await rm(path.join(runsRoot, runId), { recursive: true, force: false });
          removed = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      });
      return removed;
    },

    getRunsRoot(): string {
      return runsRoot;
    },
  };

  async function writeManifest(directory: string, ref: WikiArtifactRef): Promise<void> {
    const existing = await readManifest(runsRoot, directory);
    const artifacts = [...existing.filter((item) => item.kind !== ref.kind), ref].sort((left, right) => left.kind.localeCompare(right.kind));
    await assertNoArtifactSymlinks(runsRoot, path.join(directory, MANIFEST_FILE));
    await writeAtomic(path.join(directory, MANIFEST_FILE), Buffer.from(`${JSON.stringify({ version: 1, artifacts })}\n`, "utf8"));
  }
}

async function readManifest(runsRoot: string, directory: string): Promise<WikiArtifactRef[]> {
  try {
    await assertNoArtifactSymlinks(runsRoot, path.join(directory, MANIFEST_FILE));
    const value = JSON.parse(await readFile(path.join(directory, MANIFEST_FILE), "utf8")) as unknown;
    if (!isManifest(value)) throw new Error(`Invalid Wiki handoff manifest: ${path.join(directory, MANIFEST_FILE)}`);
    return value.artifacts.map((ref) => ({ ...ref }));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isManifest(value: unknown): value is WikiArtifactManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  const artifacts = manifest.artifacts;
  return manifest.version === 1 && Array.isArray(artifacts) && artifacts.every(isArtifactRef);
}

function isArtifactRef(value: unknown): value is WikiArtifactRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return ref.version === 1
    && typeof ref.runId === "string" && SAFE_COMPONENT.test(ref.runId)
    && typeof ref.nodeId === "string" && SAFE_COMPONENT.test(ref.nodeId)
    && typeof ref.attempt === "number" && Number.isInteger(ref.attempt) && ref.attempt > 0
    && typeof ref.kind === "string" && ARTIFACT_KINDS.has(ref.kind as WikiArtifactKind)
    && typeof ref.relativePath === "string"
    && typeof ref.sha256 === "string" && /^[a-f0-9]{64}$/.test(ref.sha256)
    && typeof ref.sizeBytes === "number" && Number.isInteger(ref.sizeBytes) && ref.sizeBytes >= 0
    && (ref.mediaType === "text/markdown" || ref.mediaType === "application/json");
}

function locationFromRef(ref: WikiArtifactRef): WikiArtifactLocation {
  if (!isArtifactRef(ref)) throw new Error("Invalid Wiki handoff artifact reference");
  const location = { runId: ref.runId, nodeId: ref.nodeId, attempt: ref.attempt, kind: ref.kind };
  if (ref.relativePath !== relativePathFor(location) || ref.mediaType !== artifactMediaType(location.kind)) {
    throw new Error("Wiki handoff artifact reference does not match its location");
  }
  return location;
}

function assertLocation(location: WikiArtifactLocation): void {
  assertComponent(location.runId, "run ID");
  assertComponent(location.nodeId, "node ID");
  assertAttempt(location.attempt);
  if (!ARTIFACT_KINDS.has(location.kind)) throw new Error("Invalid Wiki handoff artifact kind");
}

function assertComponent(value: string, label: string): void {
  if (!SAFE_COMPONENT.test(value)) throw new Error(`Invalid Wiki handoff ${label}`);
}

function assertAttempt(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new Error("Invalid Wiki handoff attempt");
}

function assertSize(bytes: Buffer, limit: number): void {
  if (bytes.byteLength > limit) throw new Error(`Wiki handoff artifact exceeds the ${limit}-byte limit (${bytes.byteLength})`);
}

function artifactFileName(kind: WikiArtifactKind): string {
  return `${kind}.json`;
}

function relativePathFor(location: WikiArtifactLocation): string {
  return path.posix.join(".okf-wiki", "runs", location.runId, location.nodeId, attemptDirectoryName(location.attempt), artifactFileName(location.kind));
}

function artifactMediaType(kind: WikiArtifactKind): WikiArtifactRef["mediaType"] {
  return "application/json";
}

function artifactSizeLimit(kind: WikiArtifactKind): number {
  if (kind === "research") return MAX_WIKI_RESEARCH_ARTIFACT_BYTES;
  if (kind === "synthesis" || kind === "review") return MAX_WIKI_JSON_ARTIFACT_BYTES;
  return MAX_WIKI_ARTIFACT_BYTES;
}

function attemptDirectoryName(attempt: number): string {
  assertAttempt(attempt);
  return `attempt-${attempt}`;
}

function attemptNumberFromDirectory(value: string): number | undefined {
  const match = /^attempt-([1-9][0-9]*)$/.exec(value);
  if (!match) return undefined;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) && attempt <= 1_000_000 ? attempt : undefined;
}

async function readUtf8Bytes(runsRoot: string, location: string, limit: number): Promise<Buffer> {
  await assertNoArtifactSymlinks(runsRoot, location);
  const bytes = await readFile(location);
  assertSize(bytes, limit);
  decodeUtf8(bytes);
  return bytes;
}

async function ensureSafeArtifactDirectory(runsRoot: string, directory: string): Promise<void> {
  await assertNoArtifactSymlinks(runsRoot, directory);
  await mkdir(directory, { recursive: true });
  await assertNoArtifactSymlinks(runsRoot, directory);
}

/** Artifact reads and writes must never traverse a symlink inside runs/. */
async function assertNoArtifactSymlinks(runsRoot: string, location: string): Promise<void> {
  const relative = path.relative(runsRoot, location);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Wiki handoff artifact path escapes its runs directory");
  }
  const parent = path.dirname(runsRoot);
  try {
    const stat = await lstat(parent);
    if (stat.isSymbolicLink()) throw new Error(`Wiki handoff artifact path contains a symbolic link: ${parent}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    const stat = await lstat(runsRoot);
    if (stat.isSymbolicLink()) throw new Error(`Wiki handoff artifact path contains a symbolic link: ${runsRoot}`);
    if (!stat.isDirectory()) throw new Error(`Wiki handoff artifact directory is invalid: ${runsRoot}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  let current = runsRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Wiki handoff artifact path contains a symbolic link: ${current}`);
      if (current !== location && !stat.isDirectory()) throw new Error(`Wiki handoff artifact directory is invalid: ${current}`);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Wiki handoff artifact must be valid UTF-8");
  }
}

async function writeAtomic(location: string, bytes: Buffer): Promise<void> {
  const temporary = path.join(path.dirname(location), `.${path.basename(location)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, location);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
