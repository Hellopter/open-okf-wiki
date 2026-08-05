/**
 * Add / remove / list workspace sources (clone or path).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { effectiveSourceIgnores } from "./ignores.mjs";
import { assertInsideRoot, sourcePath, sourcesDir } from "./paths.mjs";
import { findSource, loadWorkspace, saveWorkspace, upsertSource } from "./workspace.mjs";

function slugId(raw) {
  const s = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error("empty source id");
  return s;
}

function inferIdFromUrl(url) {
  const base = url.replace(/\/$/, "").split("/").pop() || "repo";
  return slugId(base.replace(/\.git$/i, ""));
}

function detectJavaHint(checkoutAbs) {
  try {
    const names = fs.readdirSync(checkoutAbs);
    if (names.includes("pom.xml") || names.some((n) => n.startsWith("build.gradle"))) {
      return "Java project detected; defaults include target/, *.class, .gradle/. Use: ow ignore set <id> --preset java-tests to drop tests.";
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
        "or use: ow source add clone <path-or-url>",
      { cause: err },
    );
  }
}

/**
 * @returns {{ source: object, hint?: string }}
 */
export function addPathSource(root, { linkedPath, id }) {
  const workspace = loadWorkspace(root);
  const abs = path.resolve(linkedPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`not a directory: ${abs}`);
  }
  const sourceId = slugId(id || path.basename(abs));
  if (findSource(workspace, sourceId)) {
    throw new Error(`source already exists: ${sourceId}`);
  }
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
    ignore: [],
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
  const src = findSource(workspace, sourceId);
  if (!src) throw new Error(`unknown source: ${sourceId}`);
  workspace.sources = workspace.sources.filter((s) => s.id !== sourceId);
  saveWorkspace(root, workspace);
  const dest = sourcePath(root, sourceId);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  return { removed: sourceId };
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
