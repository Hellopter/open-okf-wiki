/**
 * Load / save workspace.json
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  agentsSkillsDir,
  claudeSkillsDir,
  claudeWorkflowsDir,
  metaDir,
  runsDir,
  sourcesDir,
  workspaceJsonPath,
} from "./paths.mjs";

export function defaultWorkspace({ name, wikiLanguage = "en", rootPath }) {
  return {
    version: 1,
    id: randomUUID(),
    name: name || path.basename(rootPath),
    wikiLanguage: wikiLanguage === "zh" ? "zh" : "en",
    defaultSourceIgnores: { enabled: true },
    sources: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function loadWorkspace(root) {
  const file = workspaceJsonPath(root);
  if (!fs.existsSync(file)) {
    throw new Error(`not a workspace (missing ${file}). Run: ow init ${root}`);
  }
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (doc.version !== 1) throw new Error(`unsupported workspace version: ${doc.version}`);
  return doc;
}

export function saveWorkspace(root, doc) {
  const next = { ...doc, updatedAt: new Date().toISOString() };
  fs.writeFileSync(workspaceJsonPath(root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function ensureWorkspaceLayout(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sourcesDir(root), { recursive: true });
  fs.mkdirSync(metaDir(root), { recursive: true });
  fs.mkdirSync(runsDir(root), { recursive: true });
  fs.mkdirSync(claudeWorkflowsDir(root), { recursive: true });
  fs.mkdirSync(path.dirname(claudeSkillsDir(root)), { recursive: true });
  fs.mkdirSync(path.dirname(agentsSkillsDir(root)), { recursive: true });
}

/**
 * @returns {{ created: boolean, workspace: object }}
 */
export function initWorkspace(root, { name, wikiLanguage = "en", force = false } = {}) {
  ensureWorkspaceLayout(root);
  const file = workspaceJsonPath(root);
  if (fs.existsSync(file) && !force) {
    return { created: false, workspace: loadWorkspace(root) };
  }
  const workspace = defaultWorkspace({ name, wikiLanguage, rootPath: root });
  saveWorkspace(root, workspace);
  return { created: true, workspace };
}

export function findSource(workspace, sourceId) {
  return workspace.sources.find((s) => s.id === sourceId);
}

export function upsertSource(workspace, source) {
  const idx = workspace.sources.findIndex((s) => s.id === source.id);
  if (idx >= 0) workspace.sources[idx] = source;
  else workspace.sources.push(source);
  return workspace;
}
