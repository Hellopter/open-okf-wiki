/** v2 workspace configuration: workspace.yaml only. */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  claudeWorkflowsDir,
  defaultWorkspaceConfigPath,
  findLegacyWorkspaceConfigs,
  findWorkspaceConfig,
  metaDir,
  objectsDir,
  runsDir,
  sourcesDir,
} from "./paths.mjs";

export function defaultWorkspace({ name, wikiLanguage = "en", rootPath }) {
  return {
    version: 2,
    id: randomUUID(),
    name: name || path.basename(rootPath),
    wikiLanguage: wikiLanguage === "zh" ? "zh" : "en",
    defaultSourceIgnores: { enabled: true },
    sources: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function parseWorkspaceText(text, file) {
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    throw new Error(`invalid workspace YAML (${file}): ${error.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`workspace config must be a YAML mapping: ${file}`);
  }
  if (doc.version !== 2) {
    throw new Error(`unsupported workspace version: ${doc.version}; create a v2 workspace with ow init --force`);
  }
  if (!Array.isArray(doc.sources)) throw new Error(`workspace sources must be an array: ${file}`);
  return doc;
}

function serializeWorkspace(doc) {
  return YAML.stringify(doc, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

export function loadWorkspaceConfig(root) {
  const found = findWorkspaceConfig(root);
  if (!found) {
    const legacy = findLegacyWorkspaceConfigs(root);
    const detail = legacy.length ? `; unsupported legacy config present: ${legacy.join(", ")}` : "";
    throw new Error(`not a v2 workspace (missing workspace.yaml under ${root})${detail}. Run: ow init ${root}`);
  }
  const text = fs.readFileSync(found.path, "utf8");
  return { ...found, workspace: parseWorkspaceText(text, found.name) };
}

export function loadWorkspace(root) {
  return loadWorkspaceConfig(root).workspace;
}

export function saveWorkspace(root, doc) {
  const target = findWorkspaceConfig(root) ?? defaultWorkspaceConfigPath(root);
  const next = { ...doc, version: 2, updatedAt: new Date().toISOString() };
  fs.writeFileSync(target.path, serializeWorkspace(next), "utf8");
  return next;
}

export function ensureWorkspaceLayout(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sourcesDir(root), { recursive: true });
  fs.mkdirSync(metaDir(root), { recursive: true });
  fs.mkdirSync(runsDir(root), { recursive: true });
  fs.mkdirSync(objectsDir(root), { recursive: true });
  fs.mkdirSync(claudeWorkflowsDir(root), { recursive: true });
}

/** Create a v2 workspace. --force is an explicit replacement operation. */
export function initWorkspace(root, { name, wikiLanguage = "en", force = false } = {}) {
  ensureWorkspaceLayout(root);
  const existing = findWorkspaceConfig(root);
  const legacy = findLegacyWorkspaceConfigs(root);
  if ((existing || legacy.length) && !force) {
    if (legacy.length && !existing) {
      throw new Error(
        `unsupported legacy workspace config: ${legacy.join(", ")}; rerun ow init --force to replace it with workspace.yaml v2`,
      );
    }
    return { created: false, workspace: loadWorkspace(root), configPath: existing.path, format: "yaml" };
  }
  if (force) {
    for (const name of legacy) fs.rmSync(path.join(root, name), { force: true });
    if (existing) fs.rmSync(existing.path, { force: true });
    // A replacement v2 workspace must not inherit a run pointer or frozen
    // artifacts from a schema it no longer understands.
    fs.rmSync(metaDir(root), { recursive: true, force: true });
    fs.mkdirSync(metaDir(root), { recursive: true });
    fs.mkdirSync(runsDir(root), { recursive: true });
    fs.mkdirSync(objectsDir(root), { recursive: true });
  }
  const target = defaultWorkspaceConfigPath(root);
  const workspace = defaultWorkspace({ name, wikiLanguage, rootPath: root });
  saveWorkspace(root, workspace);
  return { created: true, workspace, configPath: target.path, format: "yaml" };
}

export function findSource(workspace, sourceId) {
  return workspace.sources.find((source) => source.id === sourceId);
}

export function upsertSource(workspace, source) {
  const index = workspace.sources.findIndex((candidate) => candidate.id === source.id);
  if (index >= 0) workspace.sources[index] = source;
  else workspace.sources.push(source);
  return workspace;
}
