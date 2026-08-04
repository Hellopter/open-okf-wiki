/**
 * Default source ignores + presets + effective expansion + path match.
 * Semantics: ADR 0015 spirit — defaults on unless disabled; user patterns additive; no !.
 */

import fs from "node:fs";
import path from "node:path";
import { kitDefaultsDir } from "./paths.mjs";

let _defaults;
let _presets;

export function loadDefaultIgnores() {
  if (_defaults) return _defaults;
  const p = path.join(kitDefaultsDir(), "default-source-ignores.json");
  _defaults = Object.freeze(JSON.parse(fs.readFileSync(p, "utf8")));
  return _defaults;
}

export function loadIgnorePresets() {
  if (_presets) return _presets;
  const p = path.join(kitDefaultsDir(), "ignore-presets.json");
  _presets = JSON.parse(fs.readFileSync(p, "utf8"));
  return _presets;
}

/**
 * @param {{ applyDefaultIgnores?: boolean, ignore?: string[], presets?: string[] }} source
 * @returns {string[]}
 */
export function effectiveSourceIgnores(source) {
  const applyDefaults = source.applyDefaultIgnores !== false;
  const base = applyDefaults ? [...loadDefaultIgnores()] : [];
  const presetIds = source.presets ?? [];
  const presets = loadIgnorePresets();
  const fromPresets = [];
  for (const id of presetIds) {
    const preset = presets[id];
    if (!preset) throw new Error(`unknown ignore preset: ${id}`);
    fromPresets.push(...preset.patterns);
  }
  const user = (source.ignore ?? []).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const pattern of [...base, ...fromPresets, ...user]) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

function normalizeRepoRelative(relativePath) {
  let p = String(relativePath ?? "").replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/")) p = p.slice(1);
  if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p;
}

/**
 * Minimal glob match for product ignore patterns (*, **, ?).
 * Bare dir names match the whole tree (node_modules → node_modules/foo).
 */
export function pathMatchesIgnore(relativePath, patterns) {
  const repoPath = normalizeRepoRelative(relativePath);
  if (!repoPath) return false;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (matchIgnoreGlob(repoPath, pattern)) return true;
  }
  return false;
}

function matchIgnoreGlob(repoPath, pattern) {
  let pat = pattern.replace(/\\/g, "/");
  if (pat.endsWith("/")) pat = pat.slice(0, -1);

  // bare segment: match dir and descendants
  if (!pat.includes("/") && !pat.includes("*") && !pat.includes("?")) {
    return repoPath === pat || repoPath.startsWith(`${pat}/`);
  }

  // basename-only globs (no /): match basename anywhere, or full path with **/prefix
  // e.g. *.class matches pkg/Foo.class and Foo.class
  if (!pat.includes("/") && (pat.includes("*") || pat.includes("?"))) {
    const base = path.posix.basename(repoPath);
    if (globToRegExp(pat).test(base)) return true;
    if (globToRegExp(`**/${pat}`).test(repoPath)) return true;
    return false;
  }

  // trailing /** also matches the directory itself
  if (pat.endsWith("/**")) {
    const prefix = pat.slice(0, -3);
    if (repoPath === prefix || repoPath.startsWith(`${prefix}/`)) return true;
  }

  return globToRegExp(pat).test(repoPath);
}

function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function listPresetSummaries() {
  const presets = loadIgnorePresets();
  return Object.entries(presets).map(([id, meta]) => ({
    id,
    label: meta.label,
    patternCount: meta.patterns.length,
  }));
}
