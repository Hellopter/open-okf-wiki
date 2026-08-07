/**
 * Pi runtime registration for a workspace.
 *
 * The kit deliberately does not install host-owned extension files. The Pi
 * extension registers the workflow identity it is about to execute, while
 * this module records the exact core and method material used by the run.
 */

import fs from "node:fs";
import path from "node:path";
import { KIT_ROOT, kitMethodDir, runtimeManifestPath } from "./paths.mjs";
import { hashTree, readJson, writeJson } from "./artifacts.mjs";

export const RUNTIME_MANIFEST_VERSION = 1;
export const PI_RUNTIME_KIND = "pi";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function packageMetadata() {
  return JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8"));
}

export function coreDigest() {
  return `sha256:${hashTree(path.join(KIT_ROOT, "scripts", "lib")).digest}`;
}

export function methodDigest() {
  const methodPath = kitMethodDir();
  if (!fs.existsSync(methodPath)) throw new Error(`missing internal method pack: ${methodPath}`);
  return `sha256:${hashTree(methodPath).digest}`;
}

function normalizeDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    throw new Error(`${label} must be a sha256:<64 lowercase hex> digest`);
  }
  return value;
}

function normalizeRuntimeDefinition(definition = {}) {
  const runtime = definition.runtimeDefinition || definition;
  const kind = runtime.kind || PI_RUNTIME_KIND;
  if (kind !== PI_RUNTIME_KIND) throw new Error(`unsupported runtime kind: ${kind}`);
  const workflow = runtime.workflow;
  if (!workflow || typeof workflow !== "object") throw new Error("Pi runtime requires a workflow definition");
  const id = typeof workflow.id === "string" ? workflow.id.trim() : "";
  if (!id) throw new Error("Pi runtime workflow.id must be a non-empty string");
  const digest = normalizeDigest(workflow.digest, "Pi runtime workflow.digest");
  const extension = typeof runtime.extension === "string" ? runtime.extension.trim() : "";
  if (!extension) throw new Error("Pi runtime extension must be a non-empty package identifier");
  return { kind, extension, workflow: { id, digest } };
}

/**
 * Persist host-owned runtime identity after the Pi extension has registered
 * its command and workflow. This does not copy any host assets into the
 * workspace and is safe to call again when the extension workflow changes.
 */
export function installRuntime(root, definition) {
  const normalized = normalizeRuntimeDefinition(definition);
  const pkg = packageMetadata();
  const manifest = {
    version: RUNTIME_MANIFEST_VERSION,
    kind: normalized.kind,
    extension: normalized.extension,
    workspaceRoot: path.resolve(root),
    core: {
      package: pkg.name,
      version: pkg.version,
      requiredVersion: pkg.version,
      digest: coreDigest(),
    },
    workflow: normalized.workflow,
    method: {
      digest: methodDigest(),
    },
    installedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(runtimeManifestPath(root)), { recursive: true });
  writeJson(runtimeManifestPath(root), manifest);
  return manifest;
}

function runtimeErrors(root, runtime, expected = {}) {
  const errors = [];
  const pkg = packageMetadata();
  if (!runtime || typeof runtime !== "object") return ["runtime manifest is not an object"];
  if (runtime.version !== RUNTIME_MANIFEST_VERSION) errors.push("runtime manifest version is unsupported");
  if (runtime.kind !== PI_RUNTIME_KIND) errors.push("runtime manifest kind must be pi");
  if (runtime.workspaceRoot !== path.resolve(root)) errors.push("runtime manifest workspaceRoot does not match workspace");
  if (typeof runtime.extension !== "string" || !runtime.extension) errors.push("runtime manifest extension is missing");
  if (runtime.core?.package !== pkg.name) errors.push("runtime manifest core package does not match installed kit");
  if (runtime.core?.version !== pkg.version || runtime.core?.requiredVersion !== pkg.version) {
    errors.push("runtime manifest core version is stale");
  }
  if (runtime.core?.digest !== coreDigest()) errors.push("runtime manifest core digest is stale");
  if (runtime.method?.digest !== methodDigest()) errors.push("runtime manifest method digest is stale");
  if (typeof runtime.workflow?.id !== "string" || !runtime.workflow.id) errors.push("runtime manifest workflow id is missing");
  if (!DIGEST_RE.test(runtime.workflow?.digest || "")) errors.push("runtime manifest workflow digest is invalid");
  if (expected.workflowId && runtime.workflow?.id !== expected.workflowId) errors.push("runtime manifest workflow id does not match Pi extension");
  if (expected.workflowDigest && runtime.workflow?.digest !== expected.workflowDigest) {
    errors.push("runtime manifest workflow digest does not match Pi extension");
  }
  if (expected.extension && runtime.extension !== expected.extension) errors.push("runtime manifest extension does not match Pi extension");
  return errors;
}

/** Validate the runtime binding before creating or recovering a run. */
export function assertRuntime(root, expected = {}) {
  const manifestPath = runtimeManifestPath(root);
  const runtime = readJson(manifestPath);
  const errors = runtimeErrors(root, runtime, expected);
  if (errors.length) {
    throw new Error(`${errors.join("; ")}. Reinitialize this workspace from the Pi /wiki command.`);
  }
  return { ok: true, runtime };
}

/**
 * Compare a desired extension descriptor to an existing manifest and update
 * only when the host workflow or core material has changed.
 */
export function ensureRuntimeManifest(root, definition) {
  const desired = normalizeRuntimeDefinition(definition);
  try {
    const checked = assertRuntime(root, {
      extension: desired.extension,
      workflowId: desired.workflow.id,
      workflowDigest: desired.workflow.digest,
    });
    return { installed: false, runtime: checked.runtime };
  } catch {
    return { installed: true, runtime: installRuntime(root, desired) };
  }
}
