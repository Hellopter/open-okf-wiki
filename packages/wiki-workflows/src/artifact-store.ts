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
  /** Workspace-relative, POSIX path to the content-addressed blob (`.okf-wiki/blobs/{sha}.{ext}`). */
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
  garbageCollect(): Promise<{ skipped: boolean; scanned: number; removed: number }>;
  getRunsRoot(): string;
}

export interface WikiArtifactStoreOptions {
  workspace: string;
  /**
   * Test seam for the durable store root.
   * Default: `<workspace>/.okf-wiki/runs` (blobs live at sibling `.okf-wiki/blobs`).
   * Custom: treat as the runs root; blobs are stored under `<rootDir>/blobs`.
   */
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
const STAGING_DIR = "staging";
const BLOBS_DIR = "blobs";

/**
 * Content-addressed handoff store.
 *
 * Layout (default under workspace):
 * - Blobs: `.okf-wiki/blobs/{sha256}.json` (or `.md` by media type)
 * - Per-run manifest: `.okf-wiki/runs/{runId}/manifest.json`
 * - Staging (agent writes): `.okf-wiki/runs/{runId}/staging/{nodeId}/attempt-{n}/{kind}.json`
 *
 * Snapshots stay pointer-only via `WikiArtifactRef`. Writes are UTF-8, size bounded,
 * hashed into blobs, and reflected in the run manifest. `removeRun` deletes only the
 * run directory (manifest + staging); blob GC is intentionally skipped to avoid races.
 */
export function createWikiArtifactStore(options: WikiArtifactStoreOptions): WikiArtifactStore {
  const workspace = path.resolve(options.workspace);
  const defaultRunsRoot = path.join(workspace, ".okf-wiki", "runs");
  const runsRoot = path.resolve(options.rootDir ?? defaultRunsRoot);
  const usingDefaultLayout = runsRoot === defaultRunsRoot;
  const okfRoot = usingDefaultLayout ? path.join(workspace, ".okf-wiki") : runsRoot;
  const blobsRoot = path.join(okfRoot, BLOBS_DIR);
  const configuredMaxBytes = options.maxBytes === undefined ? undefined : positiveInt(options.maxBytes, MAX_WIKI_ARTIFACT_BYTES);
  const limitFor = (kind: WikiArtifactKind): number => Math.min(configuredMaxBytes ?? Number.POSITIVE_INFINITY, artifactSizeLimit(kind));
  let writeChain = Promise.resolve();
  let ignoredReady: Promise<void> | undefined;

  const ensureIgnored = (): Promise<void> => {
    ignoredReady ??= usingDefaultLayout ? ensureWikiWorkspaceInternalIgnore(workspace) : Promise.resolve();
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

  const stagingAbsolute = (location: WikiArtifactLocation): string => {
    assertLocation(location);
    return path.join(
      runsRoot,
      location.runId,
      STAGING_DIR,
      location.nodeId,
      attemptDirectoryName(location.attempt),
      artifactFileName(location.kind),
    );
  };

  const blobAbsolute = (sha: string, mediaType: WikiArtifactRef["mediaType"]): string => {
    assertSha256(sha);
    return path.join(blobsRoot, blobFileName(sha, mediaType));
  };

  const runDirectory = (runId: string): string => {
    assertComponent(runId, "run ID");
    return path.join(runsRoot, runId);
  };

  const runManifestPath = (runId: string): string => path.join(runDirectory(runId), MANIFEST_FILE);

  const refFor = (location: WikiArtifactLocation, bytes: Buffer): WikiArtifactRef => {
    const digest = sha256(bytes);
    const mediaType = artifactMediaType(location.kind);
    return {
      version: 1,
      runId: location.runId,
      nodeId: location.nodeId,
      attempt: location.attempt,
      kind: location.kind,
      relativePath: blobRelativePath(digest, mediaType),
      sha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType,
    };
  };

  const writeBlob = async (ref: WikiArtifactRef, bytes: Buffer): Promise<void> => {
    const file = blobAbsolute(ref.sha256, ref.mediaType);
    await ensureSafeArtifactDirectory(okfRoot, path.dirname(file));
    await assertNoArtifactSymlinks(okfRoot, file);
    try {
      const existing = await readFile(file);
      if (sha256(existing) === ref.sha256 && existing.byteLength === ref.sizeBytes) return;
      throw new Error(`Wiki handoff blob is corrupt: ${ref.relativePath}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await writeAtomic(file, bytes);
  };

  const write = async (input: WikiArtifactWrite): Promise<WikiArtifactRef> => await enqueue(async () => {
    await ensureIgnored();
    assertLocation(input);
    const bytes = Buffer.from(input.content, "utf8");
    assertSize(bytes, limitFor(input.kind));
    const ref = refFor(input, bytes);
    await writeBlob(ref, bytes);
    await upsertRunManifest(input.runId, ref);
    return ref;
  });

  const read = async (ref: WikiArtifactRef): Promise<string> => {
    const validated = validateArtifactRef(ref);
    const file = blobAbsolute(validated.sha256, validated.mediaType);
    const bytes = await readUtf8Bytes(okfRoot, file, limitFor(validated.kind));
    if (bytes.byteLength !== validated.sizeBytes || sha256(bytes) !== validated.sha256) {
      throw new Error(`Wiki handoff artifact integrity check failed: ${validated.relativePath}`);
    }
    return decodeUtf8(bytes);
  };

  return {
    async prepare(location): Promise<string> {
      await ensureIgnored();
      const file = stagingAbsolute(location);
      await ensureSafeArtifactDirectory(okfRoot, path.dirname(file));
      return stagingRelativePath(location);
    },

    write,

    async finalize(location): Promise<WikiArtifactRef> {
      const file = stagingAbsolute(location);
      let bytes: Buffer;
      try {
        bytes = await readUtf8Bytes(okfRoot, file, limitFor(location.kind));
      } catch (error) {
        if (isMissing(error)) throw new Error(`Required ${location.kind} handoff artifact is missing: ${file}`);
        throw error;
      }
      return await write({ ...location, content: decodeUtf8(bytes) });
    },

    read,

    resolve(ref): string {
      const validated = validateArtifactRef(ref);
      return validated.relativePath;
    },

    async list(runId, nodeId, attempt): Promise<WikiArtifactRef[]> {
      await writeChain.catch(() => {});
      assertComponent(runId, "run ID");
      assertComponent(nodeId, "node ID");
      assertAttempt(attempt);
      const artifacts = await readRunManifest(okfRoot, runManifestPath(runId));
      return artifacts.filter((ref) => ref.nodeId === nodeId && ref.attempt === attempt);
    },

    async copyRun(sourceRunId, targetRunId): Promise<WikiArtifactRef[]> {
      assertComponent(sourceRunId, "run ID");
      assertComponent(targetRunId, "run ID");
      if (sourceRunId === targetRunId) throw new Error("Wiki handoff copy source and target run IDs must differ");

      return await enqueue(async () => {
        await ensureIgnored();
        const sourceManifest = runManifestPath(sourceRunId);
        let sourceArtifacts: WikiArtifactRef[];
        try {
          await assertNoArtifactSymlinks(okfRoot, sourceManifest);
          sourceArtifacts = await readRunManifest(okfRoot, sourceManifest);
        } catch (error) {
          if (isMissing(error)) return [];
          throw error;
        }
        if (sourceArtifacts.length === 0) {
          // Empty or missing source: still succeed with no entries.
          try {
            await assertNoArtifactSymlinks(okfRoot, runDirectory(sourceRunId));
          } catch (error) {
            if (isMissing(error)) return [];
            throw error;
          }
          return [];
        }

        const copied: WikiArtifactRef[] = sourceArtifacts.map((ref) => ({
          ...ref,
          runId: targetRunId,
        }));

        // Blobs are content-addressed and shared; only the run-level manifest is rewritten.
        const existing = await readRunManifest(okfRoot, runManifestPath(targetRunId));
        const merged = mergeManifestEntries(existing, copied);
        await ensureSafeArtifactDirectory(okfRoot, runDirectory(targetRunId));
        await writeAtomic(runManifestPath(targetRunId), Buffer.from(`${JSON.stringify({ version: 1, artifacts: merged })}\n`, "utf8"));
        return copied;
      });
    },

    async removeRun(runId): Promise<boolean> {
      assertComponent(runId, "run ID");
      let removed = false;
      await enqueue(async () => {
        const directory = runDirectory(runId);
        await assertNoArtifactSymlinks(okfRoot, directory);
        // The run directory is shared with history and publication state. Artifact
        // cleanup owns only its manifest and staging tree; publish journals,
        // backups, candidates, and run.json must remain recoverable.
        for (const owned of [path.join(directory, MANIFEST_FILE), path.join(directory, STAGING_DIR)]) {
          try {
            await assertNoArtifactSymlinks(okfRoot, owned);
            await rm(owned, { recursive: true, force: false });
            removed = true;
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
      });
      return removed;
    },

    async garbageCollect(): Promise<{ skipped: boolean; scanned: number; removed: number }> {
      return await enqueue(async () => {
        await ensureIgnored();
        const runEntries = await directoryNames(runsRoot);
        for (const runId of runEntries) {
          try {
            const value = JSON.parse(await readFile(path.join(runsRoot, runId, "run.json"), "utf8")) as { status?: unknown };
            if (value.status === "running" || value.status === "paused") return { skipped: true, scanned: 0, removed: 0 };
          } catch (error) {
            if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
          }
        }

        const referenced = new Set<string>();
        for (const runId of runEntries) {
          for (const ref of await readRunManifest(okfRoot, runManifestPath(runId))) referenced.add(blobFileName(ref.sha256, ref.mediaType));
        }
        let scanned = 0;
        let removed = 0;
        for (const entry of await fileNames(blobsRoot)) {
          if (!/^[a-f0-9]{64}\.(?:json|md)$/.test(entry)) continue;
          scanned += 1;
          if (referenced.has(entry)) continue;
          const absolute = path.join(blobsRoot, entry);
          await assertNoArtifactSymlinks(okfRoot, absolute);
          await rm(absolute, { force: true });
          removed += 1;
        }
        return { skipped: false, scanned, removed };
      });
    },

    getRunsRoot(): string {
      return runsRoot;
    },
  };

  async function upsertRunManifest(runId: string, ref: WikiArtifactRef): Promise<void> {
    const directory = runDirectory(runId);
    const existing = await readRunManifest(okfRoot, path.join(directory, MANIFEST_FILE));
    const artifacts = mergeManifestEntries(existing, [ref]);
    await ensureSafeArtifactDirectory(okfRoot, directory);
    await assertNoArtifactSymlinks(okfRoot, path.join(directory, MANIFEST_FILE));
    await writeAtomic(path.join(directory, MANIFEST_FILE), Buffer.from(`${JSON.stringify({ version: 1, artifacts })}\n`, "utf8"));
  }
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const unsafe = entries.find((entry) => entry.isSymbolicLink());
    if (unsafe) throw new Error(`Wiki artifact store must not contain symbolic links: ${path.join(root, unsafe.name)}`);
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_COMPONENT.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function fileNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const unsafe = entries.find((entry) => entry.isSymbolicLink());
    if (unsafe) throw new Error(`Wiki artifact store must not contain symbolic links: ${path.join(root, unsafe.name)}`);
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function mergeManifestEntries(existing: WikiArtifactRef[], incoming: WikiArtifactRef[]): WikiArtifactRef[] {
  const keyOf = (ref: WikiArtifactRef): string => `${ref.nodeId}\u0000${ref.attempt}\u0000${ref.kind}`;
  const byKey = new Map(existing.map((ref) => [keyOf(ref), ref]));
  for (const ref of incoming) byKey.set(keyOf(ref), ref);
  return [...byKey.values()].sort((left, right) => {
    const node = left.nodeId.localeCompare(right.nodeId);
    if (node !== 0) return node;
    if (left.attempt !== right.attempt) return left.attempt - right.attempt;
    return left.kind.localeCompare(right.kind);
  });
}

async function readRunManifest(okfRoot: string, manifestPath: string): Promise<WikiArtifactRef[]> {
  try {
    await assertNoArtifactSymlinks(okfRoot, manifestPath);
    const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isManifest(value)) throw new Error(`Invalid Wiki handoff manifest: ${manifestPath}`);
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

/** Validate ref shape, media type for kind, and that relativePath is the content-addressed blob path. */
function validateArtifactRef(ref: WikiArtifactRef): WikiArtifactRef {
  if (!isArtifactRef(ref)) throw new Error("Invalid Wiki handoff artifact reference");
  if (ref.mediaType !== artifactMediaType(ref.kind)) {
    throw new Error("Wiki handoff artifact reference does not match its location");
  }
  const expected = blobRelativePath(ref.sha256, ref.mediaType);
  if (ref.relativePath !== expected) {
    throw new Error("Wiki handoff artifact has an invalid relative path");
  }
  return ref;
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

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid Wiki handoff blob digest");
}

function assertSize(bytes: Buffer, limit: number): void {
  if (bytes.byteLength > limit) throw new Error(`Wiki handoff artifact exceeds the ${limit}-byte limit (${bytes.byteLength})`);
}

function artifactFileName(kind: WikiArtifactKind): string {
  return `${kind}${extensionForMediaType(artifactMediaType(kind))}`;
}

function blobFileName(sha: string, mediaType: WikiArtifactRef["mediaType"]): string {
  return `${sha}${extensionForMediaType(mediaType)}`;
}

function blobRelativePath(sha: string, mediaType: WikiArtifactRef["mediaType"]): string {
  return path.posix.join(".okf-wiki", BLOBS_DIR, blobFileName(sha, mediaType));
}

function stagingRelativePath(location: WikiArtifactLocation): string {
  assertLocation(location);
  return path.posix.join(
    ".okf-wiki",
    "runs",
    location.runId,
    STAGING_DIR,
    location.nodeId,
    attemptDirectoryName(location.attempt),
    artifactFileName(location.kind),
  );
}

function extensionForMediaType(mediaType: WikiArtifactRef["mediaType"]): string {
  return mediaType === "text/markdown" ? ".md" : ".json";
}

function artifactMediaType(kind: WikiArtifactKind): WikiArtifactRef["mediaType"] {
  void kind;
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

async function readUtf8Bytes(boundaryRoot: string, location: string, limit: number): Promise<Buffer> {
  await assertNoArtifactSymlinks(boundaryRoot, location);
  const bytes = await readFile(location);
  assertSize(bytes, limit);
  decodeUtf8(bytes);
  return bytes;
}

async function ensureSafeArtifactDirectory(boundaryRoot: string, directory: string): Promise<void> {
  await assertNoArtifactSymlinks(boundaryRoot, directory);
  await mkdir(directory, { recursive: true });
  await assertNoArtifactSymlinks(boundaryRoot, directory);
}

/**
 * Artifact reads and writes must never traverse a symlink inside the store root
 * (`.okf-wiki` by default, covering both `runs/` and `blobs/`).
 */
async function assertNoArtifactSymlinks(boundaryRoot: string, location: string): Promise<void> {
  const relative = path.relative(boundaryRoot, location);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapes) {
    throw new Error("Wiki handoff artifact path escapes its store directory");
  }
  const parent = path.dirname(boundaryRoot);
  try {
    const stat = await lstat(parent);
    if (stat.isSymbolicLink()) throw new Error(`Wiki handoff artifact path contains a symbolic link: ${parent}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    const stat = await lstat(boundaryRoot);
    if (stat.isSymbolicLink()) throw new Error(`Wiki handoff artifact path contains a symbolic link: ${boundaryRoot}`);
    if (!stat.isDirectory()) throw new Error(`Wiki handoff artifact directory is invalid: ${boundaryRoot}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (path.resolve(location) === path.resolve(boundaryRoot)) return;
  let current = boundaryRoot;
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
