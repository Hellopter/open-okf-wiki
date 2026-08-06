/** Install and verify the sole v2 Claude Code workflow asset. */

import fs from "node:fs";
import path from "node:path";
import {
  KIT_ROOT,
  LEGACY_WORKFLOWS,
  REQUIRED_WORKFLOWS,
  claudeWorkflowsDir,
  kitMethodDir,
  kitWorkflowsDir,
  runtimeManifestPath,
} from "./paths.mjs";
import { hashTree, sha256, sha256File, writeJson } from "./artifacts.mjs";

const LEGACY_ASSET_DIRS = [
  [".claude", "skills", "wiki"],
  [".claude", "skills", "repository-wiki-producer"],
  [".agents", "skills", "repository-wiki-producer"],
];

const LEGACY_WORKFLOW_DIGESTS = {
  "wiki-plan.workflow.js": "271074894b2d87b23b323128f7e96d6f46b06b6784aa094936981275daf35873",
  "wiki-write-review.workflow.js": "b970dbb8a977eab0a1c42d5a054051dc20e873943f362c336df50ac0358f309c",
  "wiki-produce.workflow.js": "c39c4e9a36bb8d3c96123a51833089b01e499041ad9dc5cc7dd5b4bbadd1f0f1",
};

const LEGACY_METHOD_MANIFEST = {
  "SKILL.md": "085fd7d35059bca2a5d60f66f4243cbb3ec2e3d96bee1696e4bb43fe8b9c64b3",
  "references/generate.md": "e2ce6dde494582247d1fa0a4da81706d3b9c6922fd67083711f8db21b7fbc99c",
  "references/orchestrator-context.md": "12934d8d3d83adacaafacd6f9a972ae6f56fc9c5f5eac5238f53ffb251c19f65",
  "references/plan.md": "af7b754f5a744cdeb6a857ac6271317521c353faca8eeebfc22a919f78e64d19",
  "references/research.md": "7c00d8da674841eb7047245fdd0e41c38b703e7e80cf7097c8c1858ad4a30b7b",
  "references/review.md": "7c7d77a63c1a57e928718065b23fbd93d9332573c712057654a690e8bd743aac",
  "templates/architecture.md": "633fa5b6348541a671240763735a239f66e29faeed623a9e829acdf3a89725cd",
  "templates/concept.md": "e278d79f5b73af3cc803fe656a1ef9b0b56e57c014c92befafd85b4b42ef5082",
  "templates/flow.md": "6574f7fa072c311f604da40af4d0039e0d5b94aee9e68301c38bad0d516180df",
  "templates/module.md": "164a6a80e89f35c39f159c7c06b44f4761acff728b3d3e97b7f766836507f53a",
  "templates/overview.md": "458db849c231891acab5933b1a08bea308d61e54e52d7e21aad5a997ea9572c8",
};

const LEGACY_ENTRY_MANIFEST = {
  "SKILL.md": "e1b0ef9d475b8fc68be450cf0b11b107294cd2bcb881747fb4529fafe8a327a0",
  "scripts/entry.mjs": "b7a41d64f052612150c6ded61325f736ca34f6a83462166601791eabb8725933",
};

function kitVersion() {
  const packagePath = path.join(KIT_ROOT, "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

/**
 * Claude Code rejects Workflow `script` bodies that contain CR or other
 * hidden controls (only TAB/LF are allowed). Normalize installed workflow
 * text to LF so Windows autocrlf/editor checkouts cannot poison /wiki.
 */
export function normalizeWorkflowText(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function readNormalizedWorkflow(file) {
  return normalizeWorkflowText(fs.readFileSync(file, "utf8"));
}

export function workflowInstallDigest(file) {
  return sha256(readNormalizedWorkflow(file));
}

/** True when the on-disk install already matches the LF-normalized kit bytes. */
function workflowAssetEquals(source, target) {
  return fs.existsSync(source) && fs.existsSync(target) && workflowInstallDigest(source) === sha256File(target);
}

/** True when logical workflow text matches after CR stripping (CRLF-safe). */
function workflowContentEquals(source, target) {
  return fs.existsSync(source) && fs.existsSync(target) && workflowInstallDigest(source) === workflowInstallDigest(target);
}

export function workflowHasHiddenControls(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function writeNormalizedWorkflow(source, target) {
  const text = readNormalizedWorkflow(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  return sha256(text);
}

function fileManifest(directory, { allowKitRoot = false } = {}) {
  const files = {};
  const stack = [""];
  while (stack.length) {
    const relative = stack.pop();
    const current = relative ? path.join(directory, relative) : directory;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, child);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files[child] = sha256File(absolute);
      else return null;
    }
  }
  if (allowKitRoot && Object.hasOwn(files, "scripts/kit-root.json")) {
    try {
      const pin = JSON.parse(fs.readFileSync(path.join(directory, "scripts", "kit-root.json"), "utf8"));
      if (typeof pin?.kitRoot !== "string" || !pin.kitRoot) return null;
      delete files["scripts/kit-root.json"];
    } catch {
      return null;
    }
  }
  return files;
}

function sameManifest(actual, expected) {
  if (!actual) return false;
  const actualPaths = Object.keys(actual).sort();
  const expectedPaths = Object.keys(expected).sort();
  return actualPaths.length === expectedPaths.length && actualPaths.every((key) => actual[key] === expected[key]);
}

function legacyAssets(root) {
  const assets = [];
  for (const name of LEGACY_WORKFLOWS) {
    const target = path.join(claudeWorkflowsDir(root), name);
    if (fs.existsSync(target)) {
      assets.push({ path: target, recognized: fs.lstatSync(target).isFile() && sha256File(target) === LEGACY_WORKFLOW_DIGESTS[name] });
    }
  }
  for (const [index, segments] of LEGACY_ASSET_DIRS.entries()) {
    const target = path.join(root, ...segments);
    if (!fs.existsSync(target)) continue;
    const manifest = fileManifest(target, { allowKitRoot: index === 0 });
    assets.push({
      path: target,
      recognized: sameManifest(manifest, index === 0 ? LEGACY_ENTRY_MANIFEST : LEGACY_METHOD_MANIFEST),
    });
  }
  return assets;
}

export function removeLegacyAssets(root) {
  const removed = [];
  const assets = legacyAssets(root);
  const unrecognized = assets.filter((asset) => !asset.recognized).map((asset) => asset.path);
  if (unrecognized.length) {
    throw new Error(`refusing to delete modified or user-owned legacy assets: ${unrecognized.join(", ")}`);
  }
  for (const asset of assets) {
    fs.rmSync(asset.path, { recursive: true, force: true });
    removed.push(asset.path);
  }
  return removed;
}

export function assertLegacyAssetsRemovable(root) {
  const unrecognized = legacyAssets(root).filter((asset) => !asset.recognized).map((asset) => asset.path);
  if (unrecognized.length) {
    throw new Error(`refusing to delete modified or user-owned legacy assets: ${unrecognized.join(", ")}`);
  }
}

function writeRuntimeManifest(root, workflowPath) {
  const hostScript = path.join(KIT_ROOT, "scripts", "ow.mjs");
  const methodPath = kitMethodDir();
  if (!fs.existsSync(methodPath)) throw new Error(`missing internal method pack: ${methodPath}`);
  const manifest = {
    version: 2,
    kitVersion: kitVersion(),
    workspaceRoot: path.resolve(root),
    hostCli: {
      node: process.execPath,
      script: hostScript,
      digest: sha256File(hostScript),
    },
    workflow: {
      path: workflowPath,
      digest: sha256File(workflowPath),
    },
    method: {
      path: methodPath,
      digest: hashTree(methodPath).digest,
    },
    installedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(runtimeManifestPath(root)), { recursive: true });
  writeJson(runtimeManifestPath(root), manifest);
  return manifest;
}

export function installWorkflows(root, { force = false } = {}) {
  const sourceDir = kitWorkflowsDir();
  const destinationDir = claudeWorkflowsDir(root);
  fs.mkdirSync(destinationDir, { recursive: true });
  const files = [];
  for (const name of REQUIRED_WORKFLOWS) {
    const source = path.join(sourceDir, name);
    const target = path.join(destinationDir, name);
    if (!fs.existsSync(source)) throw new Error(`missing required v2 workflow asset: ${source}`);
    const existed = fs.existsSync(target);
    const upToDate = existed && workflowAssetEquals(source, target) && !workflowHasHiddenControls(target);
    // Same logical content with CRLF (or other hidden controls) is auto-healed.
    // Real edits still require --force so user changes are not clobbered.
    if (existed && !force && !upToDate && !workflowContentEquals(source, target)) {
      throw new Error(`installed workflow drifted from kit: ${target}; run ow install --force`);
    }
    let digest;
    if (!existed || force || !upToDate) {
      digest = writeNormalizedWorkflow(source, target);
    } else {
      digest = sha256File(target);
    }
    files.push({
      file: name,
      path: target,
      digest,
      skipped: Boolean(existed && !force && upToDate),
      lineEndings: "lf",
    });
  }
  return { files, destDir: destinationDir };
}

export function installAll(root, { force = false } = {}) {
  const removed = force ? removeLegacyAssets(root) : [];
  const workflows = installWorkflows(root, { force });
  const workflowPath = path.join(claudeWorkflowsDir(root), REQUIRED_WORKFLOWS[0]);
  const runtime = writeRuntimeManifest(root, workflowPath);
  return { workflows, runtime, removedLegacyAssets: removed };
}

export function assertInstalledAssets(root) {
  const errors = [];
  const source = path.join(kitWorkflowsDir(), REQUIRED_WORKFLOWS[0]);
  const target = path.join(claudeWorkflowsDir(root), REQUIRED_WORKFLOWS[0]);
  if (!fs.existsSync(source)) errors.push(`missing kit workflow: ${source}`);
  else if (!fs.existsSync(target)) errors.push(`missing installed workflow: ${target}`);
  else if (workflowHasHiddenControls(target)) {
    errors.push(
      `installed workflow contains CR/control characters unsafe for Claude Workflow script approval: ${target}`,
    );
  } else if (!workflowAssetEquals(source, target)) {
    errors.push(`installed workflow drifted from kit: ${target}`);
  }

  const stale = legacyAssets(root);
  if (stale.length) errors.push(`legacy workflow/skill assets remain: ${stale.map((asset) => asset.path).join(", ")}`);

  let runtime = null;
  try {
    runtime = JSON.parse(fs.readFileSync(runtimeManifestPath(root), "utf8"));
  } catch {
    errors.push(`missing or invalid runtime manifest: ${runtimeManifestPath(root)}`);
  }
  if (runtime) {
    if (runtime.version !== 2) errors.push("runtime manifest version is not v2");
    if (runtime.workspaceRoot !== path.resolve(root)) errors.push("runtime manifest workspaceRoot does not match workspace");
    const hostScript = path.join(KIT_ROOT, "scripts", "ow.mjs");
    if (runtime.hostCli?.script !== hostScript || runtime.hostCli?.digest !== sha256File(hostScript)) {
      errors.push("runtime manifest host CLI binding is stale");
    }
    if (runtime.workflow?.path !== target || runtime.workflow?.digest !== (fs.existsSync(target) ? sha256File(target) : null)) {
      errors.push("runtime manifest workflow binding is stale");
    }
    const methodPath = kitMethodDir();
    if (!fs.existsSync(methodPath) || runtime.method?.path !== methodPath || runtime.method?.digest !== hashTree(methodPath).digest) {
      errors.push("runtime manifest method binding is stale");
    }
  }
  if (errors.length) throw new Error(`${errors.join("; ")}. Run: ow install --force`);
  return { ok: true, runtime };
}

export function ensureWorkflowsInstalled(root) {
  const target = path.join(claudeWorkflowsDir(root), REQUIRED_WORKFLOWS[0]);
  if (!fs.existsSync(target) || !fs.existsSync(runtimeManifestPath(root))) {
    installAll(root, { force: false });
  }
  return assertInstalledAssets(root);
}
