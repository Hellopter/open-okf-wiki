/**
 * Workspace-local content-addressed object store for freeze materialization.
 * Objects are write-once under .wiki-agent/objects/sha256/<aa>/<digest>.
 * Run workdirs hardlink into objects when possible, otherwise copy.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sha256, sha256File } from "./artifacts.mjs";
import { objectPath, objectsDir } from "./paths.mjs";

const LINK_FALLBACK_CODES = new Set([
  "EXDEV",
  "EPERM",
  "EACCES",
  "EMLINK",
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
]);

export function emptyPlacement() {
  return {
    hardlinked: 0,
    copied: 0,
    objectsCreated: 0,
    objectsReused: 0,
    bytesLogical: 0,
    fallbackReasons: {},
  };
}

export function mergePlacement(target, source) {
  target.hardlinked += source.hardlinked || 0;
  target.copied += source.copied || 0;
  target.objectsCreated += source.objectsCreated || 0;
  target.objectsReused += source.objectsReused || 0;
  target.bytesLogical += source.bytesLogical || 0;
  for (const [code, count] of Object.entries(source.fallbackReasons || {})) {
    target.fallbackReasons[code] = (target.fallbackReasons[code] || 0) + count;
  }
  return target;
}

export function markReadonly(abs) {
  try {
    fs.chmodSync(abs, 0o444);
  } catch {
    /* best-effort: Windows/cloud FS may no-op or refuse */
  }
}

/**
 * Ensure a CAS object exists for the given content.
 * @returns {{ digest: string, path: string, created: boolean, bytes: number }}
 */
export function ensureObjectFromBuffer(root, buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const digest = sha256(bytes);
  const dest = objectPath(root, digest);
  if (fs.existsSync(dest)) {
    return { digest, path: dest, created: false, bytes: bytes.length };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temporary = path.join(
    path.dirname(dest),
    `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    fs.writeFileSync(temporary, bytes);
    try {
      fs.renameSync(temporary, dest);
    } catch (error) {
      // Concurrent freeze of the same digest: treat as reuse.
      if (error?.code === "EEXIST" || fs.existsSync(dest)) {
        fs.rmSync(temporary, { force: true });
        return { digest, path: dest, created: false, bytes: bytes.length };
      }
      throw error;
    }
    markReadonly(dest);
    return { digest, path: dest, created: true, bytes: bytes.length };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Ensure a CAS object exists for a regular file on disk.
 * Reads the file once (same cost class as hashTree).
 */
export function ensureObjectFromFile(root, srcAbs) {
  const content = fs.readFileSync(srcAbs);
  return ensureObjectFromBuffer(root, content);
}

/**
 * Place a CAS object (or any file) at dest via hardlink, falling back to copy.
 * Never creates a symlink/junction.
 * @returns {"hardlink" | "copy"}
 */
export function placeObject(objectAbs, destAbs, { reasonBucket } = {}) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  if (fs.existsSync(destAbs)) {
    fs.rmSync(destAbs, { force: true });
  }
  try {
    fs.linkSync(objectAbs, destAbs);
    return "hardlink";
  } catch (error) {
    const code = error?.code || "UNKNOWN";
    if (!LINK_FALLBACK_CODES.has(code) && code !== "UNKNOWN") {
      // Unexpected errors still fall back so freeze remains usable.
    }
    if (reasonBucket) {
      reasonBucket[code] = (reasonBucket[code] || 0) + 1;
    }
    fs.copyFileSync(objectAbs, destAbs);
    return "copy";
  }
}

/**
 * Materialize one source file into the freeze tree via CAS.
 * @returns {{ method: "hardlink"|"copy", digest: string, created: boolean, bytes: number }}
 */
export function materializeFile(root, srcAbs, destAbs, placement) {
  const object = ensureObjectFromFile(root, srcAbs);
  if (object.created) placement.objectsCreated += 1;
  else placement.objectsReused += 1;
  placement.bytesLogical += object.bytes;
  const method = placeObject(object.path, destAbs, { reasonBucket: placement.fallbackReasons });
  if (method === "hardlink") placement.hardlinked += 1;
  else placement.copied += 1;
  return { method, digest: object.digest, created: object.created, bytes: object.bytes };
}

/** Walk every CAS object under objects/sha256. Yields absolute paths. */
export function* walkObjects(root) {
  const base = path.join(objectsDir(root), "sha256");
  if (!fs.existsSync(base)) return;
  for (const shard of fs.readdirSync(base, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(base, shard.name);
    for (const ent of fs.readdirSync(shardDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (ent.name.startsWith(".tmp-")) continue;
      yield path.join(shardDir, ent.name);
    }
  }
}

/**
 * Digest from object path filename (full 64-hex name).
 */
export function digestFromObjectPath(objectAbs) {
  return path.basename(objectAbs).toLowerCase();
}

export { objectPath, objectsDir, sha256File };
