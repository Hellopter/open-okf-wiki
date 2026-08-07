/**
 * Add / remove / list workspace sources (clone or path).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { effectiveSourceIgnores } from "./ignores.mjs";
import { assertInsideRoot, sourcePath, sourcesDir } from "./paths.mjs";
import { findSource, loadWorkspace, saveWorkspace, upsertSource } from "./workspace.mjs";

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeIgnorePatterns(ignore) {
  if (ignore === undefined) return [];
  if (!Array.isArray(ignore)) throw new Error("source ignore must be an array of patterns");
  const patterns = ignore.map((pattern) => {
    if (typeof pattern !== "string") throw new Error("source ignore patterns must be strings");
    const normalized = pattern.trim();
    if (normalized.startsWith("!")) throw new Error("negated source ignore patterns are not supported");
    return normalized;
  }).filter(Boolean);
  return [...new Set(patterns)];
}

function assertSourceId(value) {
  const sourceId = String(value || "");
  if (!SOURCE_ID_RE.test(sourceId)) {
    throw new Error(`invalid source id: ${value}`);
  }
  return sourceId;
}

function slugId(raw) {
  const s = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error("empty source id");
  return assertSourceId(s);
}

function inferIdFromUrl(url) {
  const base = url.replace(/\/$/, "").split("/").pop() || "repo";
  return slugId(base.replace(/\.git$/i, ""));
}

function detectJavaHint(checkoutAbs) {
  try {
    const names = fs.readdirSync(checkoutAbs);
    if (names.includes("pom.xml") || names.some((n) => n.startsWith("build.gradle"))) {
      return "Java project detected; defaults include target/, *.class, .gradle/. Use /wiki source configuration to apply the java-tests preset.";
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @returns {{ source: object, hint?: string }}
 */
export function addCloneSource(root, { url, id, ref, depth = 1 }) {
  const workspace = loadWorkspace(root);
  const sourceId = slugId(id || inferIdFromUrl(url));
  if (findSource(workspace, sourceId)) {
    throw new Error(`source already exists: ${sourceId}`);
  }
  const dest = sourcePath(root, sourceId);
  fs.mkdirSync(sourcesDir(root), { recursive: true });
  if (fs.existsSync(dest)) {
    throw new Error(`destination exists: ${dest}`);
  }
  const args = ["clone"];
  if (depth > 0) args.push("--depth", String(depth));
  if (ref) args.push("--branch", ref);
  args.push(url, dest);
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git clone failed: ${r.stderr || r.stdout || r.status}`);
  }
  const applyDefaultIgnores = workspace.defaultSourceIgnores?.enabled !== false;
  const source = {
    id: sourceId,
    path: path.relative(root, dest) || `sources/${sourceId}`,
    applyDefaultIgnores,
    ignore: [],
    presets: [],
    origin: {
      type: "clone",
      remoteUrl: url,
      ref: ref || undefined,
      clonedAt: new Date().toISOString(),
    },
  };
  upsertSource(workspace, source);
  saveWorkspace(root, workspace);
  const hint = detectJavaHint(dest);
  return { source, hint };
}

/** UNC / network share path (not a valid Windows junction target). */
function isUncPath(absPath) {
  return /^[\\/]{2}[^\\/]+/.test(absPath);
}

/**
 * Link a local directory into workspace sources/ for a uniform layout.
 * On Windows, prefer a directory junction so ordinary users do not need
 * Developer Mode or an elevated shell. Junctions require an absolute local
 * path and cannot target UNC shares; those fall back to a dir symlink.
 * @returns {"junction" | "dir"}
 */
export function linkPathSource(absTarget, dest) {
  const target = path.resolve(absTarget);
  if (process.platform !== "win32") {
    fs.symlinkSync(target, dest, "dir");
    return "dir";
  }

  // Junctions are local-only and must use an absolute path.
  if (!isUncPath(target)) {
    try {
      fs.symlinkSync(target, dest, "junction");
      return "junction";
    } catch (err) {
      // Fall through to a dir symlink (needs Developer Mode or admin).
      if (err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EINVAL")) {
        /* try symlink below */
      } else if (err) {
        throw err;
      }
    }
  }

  try {
    fs.symlinkSync(target, dest, "dir");
    return "dir";
  } catch (err) {
    const code = err?.code ? ` (${err.code})` : "";
    throw new Error(
      `failed to link path source${code}: ${target} -> ${dest}. ` +
        "On Windows, local paths use a directory junction (no admin). " +
        "Network/UNC paths need Developer Mode or an elevated shell for a symlink, " +
        "or add the source as a clone through /wiki source add clone <path-or-url>",
      { cause: err },
    );
  }
}

/**
 * @returns {{ source: object, hint?: string }}
 */
export function addPathSource(root, { linkedPath, id, ignore } = {}) {
  const workspace = loadWorkspace(root);
  const abs = path.resolve(linkedPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`not a directory: ${abs}`);
  }
  const sourceId = slugId(id || path.basename(abs));
  if (findSource(workspace, sourceId)) {
    throw new Error(`source already exists: ${sourceId}`);
  }
  const userIgnore = normalizeIgnorePatterns(ignore);
  const dest = sourcePath(root, sourceId);
  fs.mkdirSync(sourcesDir(root), { recursive: true });
  if (fs.existsSync(dest)) {
    throw new Error(`destination exists: ${dest}`);
  }
  const linkType = linkPathSource(abs, dest);
  const applyDefaultIgnores = workspace.defaultSourceIgnores?.enabled !== false;
  const source = {
    id: sourceId,
    path: path.relative(root, dest) || `sources/${sourceId}`,
    applyDefaultIgnores,
    ignore: userIgnore,
    presets: [],
    origin: {
      type: "path",
      linkedPath: abs,
      linkType,
    },
  };
  upsertSource(workspace, source);
  saveWorkspace(root, workspace);
  const hint = detectJavaHint(abs);
  return { source, hint };
}

export function removeSource(root, sourceId) {
  const workspace = loadWorkspace(root);
  const id = assertSourceId(sourceId);
  const src = findSource(workspace, id);
  if (!src) throw new Error(`unknown source: ${sourceId}`);
  assertSourceId(src.id);

  const workspaceReal = fs.realpathSync(root);
  const sourcesReal = fs.realpathSync(sourcesDir(root));
  assertInsideRoot(workspaceReal, sourcesReal);
  const dest = sourcePath(root, id);
  const parentReal = fs.realpathSync(path.dirname(dest));
  if (parentReal !== sourcesReal) {
    throw new Error(`source path escapes sources directory: ${sourceId}`);
  }

  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      // A linked local source is an entry under sources/, not its external target.
      fs.unlinkSync(dest);
    } else {
      const destReal = fs.realpathSync(dest);
      if (!isInside(sourcesReal, destReal)) {
        throw new Error(`source path escapes sources directory: ${sourceId}`);
      }
      fs.rmSync(dest, { recursive: true, force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  workspace.sources = workspace.sources.filter((source) => source.id !== id);
  saveWorkspace(root, workspace);
  return { removed: id };
}

export function listSources(root) {
  const workspace = loadWorkspace(root);
  return workspace.sources.map((s) => ({
    ...s,
    effectiveIgnores: effectiveSourceIgnores(s),
    absPath: path.resolve(root, s.path),
  }));
}

export function resolveSourceAbs(root, source) {
  const abs = path.resolve(root, source.path);
  assertInsideRoot(root, abs);
  return abs;
}
