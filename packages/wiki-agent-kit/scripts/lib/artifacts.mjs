/** Deterministic artifact helpers used by freeze, gates, and candidate sealing. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function sha256Json(value) {
  return sha256(stableJson(value));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash every regular file below a directory. Limits fail closed rather than
 * silently producing a partial digest.
 */
export function hashTree(root, { maxFiles = 50_000 } = {}) {
  const files = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(root, childRel);
      if (ent.isDirectory()) stack.push(childRel);
      else if (ent.isFile()) {
        files.push(childRel.replace(/\\/g, "/"));
        if (files.length > maxFiles) {
          throw new Error(`file limit exceeded (${maxFiles}) while hashing ${root}`);
        }
      }
    }
  }
  files.sort();
  const hash = createHash("sha256");
  const manifest = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(root, rel));
    const digest = sha256(content);
    manifest.push({ path: rel, bytes: content.length, sha256: digest });
    hash.update(rel);
    hash.update("\0");
    hash.update(digest);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: files.length, files: manifest };
}

export function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
