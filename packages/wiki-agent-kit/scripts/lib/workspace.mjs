/**
 * Load / save workspace.yaml|yml|json
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  agentsSkillsDir,
  claudeSkillsDir,
  claudeWorkflowsDir,
  defaultWorkspaceConfigPath,
  findWorkspaceConfig,
  metaDir,
  runsDir,
  sourcesDir,
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

function parseWorkspaceText(text, format, file) {
  let doc;
  if (format === "json") {
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new Error(`invalid workspace JSON (${file}): ${err.message}`);
    }
  } else {
    try {
      doc = YAML.parse(text);
    } catch (err) {
      throw new Error(`invalid workspace YAML (${file}): ${err.message}`);
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`workspace config must be a mapping/object: ${file}`);
  }
  if (doc.version !== 1) throw new Error(`unsupported workspace version: ${doc.version}`);
  return doc;
}

function serializeWorkspace(doc, format) {
  if (format === "json") {
    return `${JSON.stringify(doc, null, 2)}\n`;
  }
  return YAML.stringify(doc, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

/**
 * @returns {{ path: string, format: "yaml"|"json", name: string, workspace: object }}
 */
export function loadWorkspaceConfig(root) {
  const found = findWorkspaceConfig(root);
  if (!found) {
    throw new Error(
      `not a workspace (missing workspace.yaml|workspace.yml|workspace.json under ${root}). Run: ow init ${root}`,
    );
  }
  const text = fs.readFileSync(found.path, "utf8");
  const workspace = parseWorkspaceText(text, found.format, found.name);
  return { ...found, workspace };
}

export function loadWorkspace(root) {
  return loadWorkspaceConfig(root).workspace;
}

/**
 * Persist workspace. Writes back to the existing config file when present;
 * otherwise creates the default format (yaml unless opts.format is set).
 * @param {string} root
 * @param {object} doc
 * @param {{ format?: "yaml"|"json" }} [opts]
 */
export function saveWorkspace(root, doc, opts = {}) {
  const existing = findWorkspaceConfig(root);
  const target = existing ?? defaultWorkspaceConfigPath(root, opts.format === "json" ? "json" : "yaml");
  const next = { ...doc, updatedAt: new Date().toISOString() };
  fs.writeFileSync(target.path, serializeWorkspace(next, target.format), "utf8");
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
 * @returns {{ created: boolean, workspace: object, configPath: string, format: "yaml"|"json" }}
 */
export function initWorkspace(root, { name, wikiLanguage = "en", force = false, format = "yaml" } = {}) {
  ensureWorkspaceLayout(root);
  const existing = findWorkspaceConfig(root);
  if (existing && !force) {
    return {
      created: false,
      workspace: loadWorkspace(root),
      configPath: existing.path,
      format: existing.format,
    };
  }
  if (existing && force) {
    fs.rmSync(existing.path, { force: true });
  }
  const target = defaultWorkspaceConfigPath(root, format === "json" ? "json" : "yaml");
  const workspace = defaultWorkspace({ name, wikiLanguage, rootPath: root });
  saveWorkspace(root, workspace, { format: target.format });
  return { created: true, workspace, configPath: target.path, format: target.format };
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
