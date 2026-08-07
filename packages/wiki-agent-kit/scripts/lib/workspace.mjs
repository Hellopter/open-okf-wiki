/** V4 workspace configuration and its deliberately small workflow policy. */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  defaultWorkspaceConfigPath,
  findLegacyWorkspaceConfigs,
  findWorkspaceConfig,
  metaDir,
  runsDir,
  sourcesDir,
} from "./paths.mjs";

export const WORKSPACE_VERSION = 4;
export const APPROVAL_MODES = new Set(["propose", "auto"]);

function normalizeApproval(value) {
  const approval = value ?? "propose";
  if (!APPROVAL_MODES.has(approval)) {
    throw new Error(`workspace workflow.approval must be one of: ${[...APPROVAL_MODES].join(", ")}`);
  }
  return approval;
}

export function defaultWorkspace({ name, wikiLanguage = "en", rootPath }) {
  const now = new Date().toISOString();
  return {
    version: WORKSPACE_VERSION,
    id: randomUUID(),
    name: name || path.basename(rootPath),
    wikiLanguage: wikiLanguage === "zh" ? "zh" : "en",
    workflow: { approval: "propose" },
    defaultSourceIgnores: { enabled: true },
    sources: [],
    createdAt: now,
    updatedAt: now,
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
  if (doc.version !== WORKSPACE_VERSION) {
    throw new Error(
      `unsupported workspace version: ${doc.version}; this is a v4-only Wiki workspace. Recreate it with /wiki init --force`,
    );
  }
  if (!Array.isArray(doc.sources)) throw new Error(`workspace sources must be an array: ${file}`);
  if (doc.workflow !== undefined && (!doc.workflow || typeof doc.workflow !== "object" || Array.isArray(doc.workflow))) {
    throw new Error(`workspace workflow must be a YAML mapping: ${file}`);
  }
  return { ...doc, workflow: { approval: normalizeApproval(doc.workflow?.approval) } };
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
    throw new Error(`not a v4 workspace (missing workspace.yaml under ${root})${detail}. Run: /wiki init ${root}`);
  }
  const text = fs.readFileSync(found.path, "utf8");
  return { ...found, workspace: parseWorkspaceText(text, found.name) };
}

export function loadWorkspace(root) {
  return loadWorkspaceConfig(root).workspace;
}

export function saveWorkspace(root, doc) {
  const target = findWorkspaceConfig(root) ?? defaultWorkspaceConfigPath(root);
  const next = {
    ...doc,
    version: WORKSPACE_VERSION,
    workflow: { approval: normalizeApproval(doc?.workflow?.approval) },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(target.path, serializeWorkspace(next), "utf8");
  return next;
}

export function ensureWorkspaceLayout(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sourcesDir(root), { recursive: true });
  fs.mkdirSync(metaDir(root), { recursive: true });
  fs.mkdirSync(runsDir(root), { recursive: true });
}

/** Create a V4 workspace. --force explicitly discards only generated run state. */
export function initWorkspace(root, { name, wikiLanguage = "en", force = false } = {}) {
  ensureWorkspaceLayout(root);
  const existing = findWorkspaceConfig(root);
  const legacy = findLegacyWorkspaceConfigs(root);
  if ((existing || legacy.length) && !force) {
    if (legacy.length && !existing) {
      throw new Error(
        `unsupported legacy workspace config: ${legacy.join(", ")}; rerun /wiki init --force to replace it with workspace.yaml v4`,
      );
    }
    return { created: false, workspace: loadWorkspace(root), configPath: existing.path, format: "yaml" };
  }
  if (force) {
    for (const name of legacy) fs.rmSync(path.join(root, name), { force: true });
    if (existing) fs.rmSync(existing.path, { force: true });
    fs.rmSync(metaDir(root), { recursive: true, force: true });
    fs.mkdirSync(metaDir(root), { recursive: true });
    fs.mkdirSync(runsDir(root), { recursive: true });
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
