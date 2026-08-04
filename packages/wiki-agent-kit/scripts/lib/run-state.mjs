/**
 * Journal append / read for continue & retry.
 */

import fs from "node:fs";
import path from "node:path";
import { runDir } from "./paths.mjs";
import { loadRunMeta } from "./freeze.mjs";

export function journalPath(root, runId) {
  return path.join(runDir(root, runId), "journal.jsonl");
}

export function appendJournal(root, runId, entry) {
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() });
  fs.appendFileSync(journalPath(root, runId), `${line}\n`, "utf8");
}

export function readJournal(root, runId) {
  const p = journalPath(root, runId);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function journalDoneIds(root, runId) {
  return new Set(
    readJournal(root, runId)
      .filter((e) => e.status === "done" && e.callId)
      .map((e) => e.callId),
  );
}

/**
 * Drop journal entries for phases at or after `fromPhase` (retry).
 * Phase order for produce pipeline.
 */
const PHASE_ORDER = [
  "freeze",
  "inventory",
  "discover",
  "plan",
  "write",
  "review",
  "repair",
  "validate",
  "publish",
];

export function retryFromPhase(root, runId, fromPhase) {
  const meta = loadRunMeta(root, runId);
  const idx = PHASE_ORDER.indexOf(fromPhase);
  if (idx < 0) throw new Error(`unknown phase: ${fromPhase}`);
  const drop = new Set(PHASE_ORDER.slice(idx));
  const kept = readJournal(root, runId).filter((e) => !drop.has(e.phase));
  const p = journalPath(root, runId);
  fs.writeFileSync(p, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf8");
  meta.status = "retrying";
  meta.phase = fromPhase;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(runDir(root, runId), "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
  return { runId, fromPhase, kept: kept.length, meta };
}

export function continuePlan(root, runId) {
  const meta = loadRunMeta(root, runId);
  const done = [...journalDoneIds(root, runId)];
  meta.status = "continuing";
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(runDir(root, runId), "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
  return {
    runId,
    skipCallIds: done,
    workdir: path.join(runDir(root, runId), "workdir"),
    meta,
  };
}
