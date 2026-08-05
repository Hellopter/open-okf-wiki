/** Artifact cleanup for explicit workflow retries. Claude owns in-session resume. */

import fs from "node:fs";
import path from "node:path";
import { setActiveRun } from "./active-run.mjs";
import { candidateManifestPath } from "./paths.mjs";
import { gateReceiptPath } from "./gate.mjs";
import { loadRunMeta } from "./freeze.mjs";

const PHASES = ["plan", "write"];

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function retryFromPhase(root, runId, fromPhase, { approvePlan = false, produce = true } = {}) {
  if (!PHASES.includes(fromPhase)) throw new Error(`unknown phase: ${fromPhase}`);
  const meta = loadRunMeta(root, runId);
  const workdir = path.resolve(root, meta.workdir);
  const analysis = path.join(workdir, "analysis");
  const candidate = path.join(workdir, "candidate");
  const removed = [];
  const removeTracked = (target) => {
    remove(target);
    removed.push(path.relative(workdir, target));
  };

  if (fromPhase === "plan") {
    removeTracked(path.join(analysis, "receipts"));
    removeTracked(path.join(analysis, "discovery-map.json"));
    removeTracked(path.join(analysis, "spec.json"));
    removeTracked(gateReceiptPath(workdir));
    removeTracked(path.join(analysis, "defects.json"));
    removeTracked(path.join(analysis, "validation.json"));
    removeTracked(candidate);
    fs.mkdirSync(candidate, { recursive: true });
    fs.mkdirSync(path.join(analysis, "receipts", "survey"), { recursive: true });
    fs.mkdirSync(path.join(analysis, "receipts", "semantic"), { recursive: true });
  }
  if (fromPhase === "write") {
    removeTracked(path.join(analysis, "receipts", "review"));
    removeTracked(path.join(analysis, "defects.json"));
    removeTracked(path.join(analysis, "validation.json"));
    removeTracked(candidate);
    fs.mkdirSync(candidate, { recursive: true });
  }
  removeTracked(candidateManifestPath(workdir));

  const command =
    fromPhase === "write"
      ? "/wiki-write-review"
      : approvePlan || !produce
        ? "/wiki-plan"
        : "/wiki-produce";
  const pointers = setActiveRun(root, {
    runId,
    workdir,
    command,
    phase: fromPhase === "write" ? "write-ready" : "frozen",
    reason: `retry --from ${fromPhase}`,
    approvePlan,
    produce: !approvePlan && produce,
  });

  return { runId, fromPhase, removed, current: pointers.current, nextAction: pointers.nextAction, workflow: { command } };
}
