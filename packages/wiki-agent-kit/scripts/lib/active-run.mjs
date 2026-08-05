/**
 * Workspace-level active run pointers for no-arg Claude workflows.
 * Workflows prefer args when present; otherwise agents resolve these files.
 */

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./artifacts.mjs";
import { loadRunMeta, listRuns } from "./freeze.mjs";
import { currentRunPath, nextActionPath, runDir } from "./paths.mjs";

export function readCurrent(root) {
  return readJson(currentRunPath(root));
}

export function readNextAction(root) {
  return readJson(nextActionPath(root));
}

export function clearActivePointers(root) {
  fs.rmSync(currentRunPath(root), { force: true });
  fs.rmSync(nextActionPath(root), { force: true });
}

/**
 * @param {string} root
 * @param {{
 *   runId: string,
 *   workdir: string,
 *   command: string,
 *   phase?: string,
 *   reason?: string,
 *   approvePlan?: boolean,
 *   produce?: boolean,
 * }} data
 */
export function setActiveRun(root, data) {
  const workdirAbs = path.resolve(data.workdir);
  const now = new Date().toISOString();
  const previous = readCurrent(root);
  const produce =
    typeof data.produce === "boolean"
      ? data.produce
      : typeof previous?.produce === "boolean"
        ? previous.produce
        : !Boolean(data.approvePlan);
  const current = {
    version: 1,
    runId: data.runId,
    workdir: workdirAbs,
    phase: data.phase || "frozen",
    command: data.command,
    approvePlan: Boolean(data.approvePlan),
    produce,
    updatedAt: now,
  };
  const nextAction = {
    version: 1,
    runId: data.runId,
    workdir: workdirAbs,
    command: data.command,
    phase: data.phase || "frozen",
    reason: data.reason || null,
    approvePlan: Boolean(data.approvePlan),
    produce,
    updatedAt: now,
  };
  fs.mkdirSync(path.dirname(currentRunPath(root)), { recursive: true });
  writeJson(currentRunPath(root), current);
  writeJson(nextActionPath(root), nextAction);
  return { current, nextAction };
}

/**
 * Update next-action (and current phase/command) without changing run identity.
 * @param {string} root
 * @param {{ command: string, phase?: string, reason?: string, approvePlan?: boolean, produce?: boolean }} patch
 */
export function setNextAction(root, patch) {
  const current = readCurrent(root);
  if (!current?.runId || !current?.workdir) {
    throw new Error("no active run pointer; run: ow freeze or ow run");
  }
  return setActiveRun(root, {
    runId: current.runId,
    workdir: current.workdir,
    command: patch.command,
    phase: patch.phase || current.phase,
    reason: patch.reason,
    approvePlan: patch.approvePlan ?? current.approvePlan,
    produce: patch.produce ?? current.produce,
  });
}

/**
 * Resolve the active run for CLI/status.
 * Priority: preferredRunId → current.json → next-action.json → newest run meta.
 * @returns {{ runId: string, workdir: string, source: string, meta?: object, current?: object, nextAction?: object } | null}
 */
export function resolveActiveRun(root, { preferredRunId } = {}) {
  const current = readCurrent(root);
  const nextAction = readNextAction(root);

  const tryRun = (runId, source) => {
    if (typeof runId !== "string" || !runId) return null;
    try {
      const meta = loadRunMeta(root, runId);
      const workdir = path.resolve(root, meta.workdir);
      if (!fs.existsSync(workdir)) return null;
      return { runId, workdir, source, meta, current, nextAction };
    } catch {
      return null;
    }
  };

  if (preferredRunId) {
    const hit = tryRun(preferredRunId, "arg");
    if (hit) return hit;
  }

  if (current?.runId) {
    const hit = tryRun(current.runId, "current");
    if (hit) {
      // Prefer absolute workdir recorded in the pointer when still valid.
      if (typeof current.workdir === "string" && fs.existsSync(current.workdir)) {
        hit.workdir = path.resolve(current.workdir);
      }
      return hit;
    }
  }

  if (nextAction?.runId) {
    const hit = tryRun(nextAction.runId, "next-action");
    if (hit) {
      if (typeof nextAction.workdir === "string" && fs.existsSync(nextAction.workdir)) {
        hit.workdir = path.resolve(nextAction.workdir);
      }
      return hit;
    }
  }

  const runs = listRuns(root).filter((meta) => meta?.runId && meta.status !== "corrupt");
  for (const meta of runs) {
    const workdir = path.resolve(root, meta.workdir);
    if (fs.existsSync(workdir) || fs.existsSync(runDir(root, meta.runId))) {
      return {
        runId: meta.runId,
        workdir,
        source: "latest-run",
        meta,
        current,
        nextAction,
      };
    }
  }
  return null;
}

export function workflowInvocation(name, root, { runId, workdir, requireArgs = false } = {}) {
  const base = {
    command: `/${name}`,
    cwd: root,
  };
  if (requireArgs) {
    if (!runId || !workdir) throw new Error("runId and workdir required for args-mode invocation");
    return {
      ...base,
      args: { runId, workdir },
      instructions: `From ${root}, run /${name} (args optional if .wiki-agent/current.json is present). Explicit args: ${JSON.stringify({ runId, workdir })}`,
    };
  }
  return {
    ...base,
    args: runId && workdir ? { runId, workdir } : undefined,
    instructions:
      `From ${root}, run /${name} with no arguments. ` +
      `The workflow resolves .wiki-agent/current.json (or next-action.json). ` +
      (runId ? `Active runId=${runId}.` : "Run ow freeze or ow run first if no active pointer exists."),
  };
}
