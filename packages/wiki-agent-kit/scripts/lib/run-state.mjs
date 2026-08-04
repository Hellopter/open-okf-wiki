/** Artifact cleanup for explicit workflow retries. Claude owns in-session resume. */

import fs from "node:fs";
import path from "node:path";
import { candidateManifestPath, runDir } from "./paths.mjs";
import { gateReceiptPath } from "./gate.mjs";
import { loadRunMeta } from "./freeze.mjs";

const PHASES = ["discover", "plan", "write", "review"];

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function retryFromPhase(root, runId, fromPhase) {
  if (!PHASES.includes(fromPhase)) throw new Error(`unknown phase: ${fromPhase}`);
  const meta = loadRunMeta(root, runId);
  const workdir = path.join(root, meta.workdir);
  const analysis = path.join(workdir, "analysis");
  const candidate = path.join(workdir, "candidate");
  const removed = [];
  const removeTracked = (target) => {
    remove(target);
    removed.push(path.relative(workdir, target));
  };

  if (fromPhase === "discover") {
    removeTracked(path.join(analysis, "receipts"));
    removeTracked(path.join(analysis, "discovery-map.json"));
    removeTracked(path.join(analysis, "spec.json"));
  }
  if (fromPhase === "discover" || fromPhase === "plan") {
    removeTracked(gateReceiptPath(workdir));
  }
  if (fromPhase === "discover" || fromPhase === "plan" || fromPhase === "write") {
    removeTracked(candidate);
    fs.mkdirSync(candidate, { recursive: true });
  }
  removeTracked(path.join(analysis, "defects.json"));
  removeTracked(candidateManifestPath(workdir));

  meta.status = "retrying";
  meta.phase = fromPhase;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir(root, runId), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return { runId, fromPhase, removed, meta };
}
