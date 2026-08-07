/**
 * Survey coverage scanning and agent staleness helpers for orchestration.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { WikiAgentView, WikiCoverageView } from "./types.js";

export interface ScanSurveyCoverageOptions {
  /** Survey pass number recorded on the coverage view. Defaults to 1. */
  pass?: number;
  /** Inventory units that should eventually have receipts. */
  inventoryUnits?: { id: string }[];
}

/**
 * Scan `workdir/analysis/receipts/survey/*.json` and report unit coverage.
 *
 * Prefers `coverageUnit.id` from each receipt body; falls back to a filename
 * heuristic that matches sanitized inventory unit ids.
 *
 * Returns `undefined` when the receipts directory does not exist.
 */
export async function scanSurveyCoverage(
  workdir: string,
  options: ScanSurveyCoverageOptions = {},
): Promise<WikiCoverageView | undefined> {
  const receiptsDir = join(workdir, "analysis", "receipts", "survey");
  if (!existsSync(receiptsDir)) {
    return undefined;
  }

  const pass = options.pass ?? 1;
  const inventory = options.inventoryUnits ?? [];

  /** Unit ids taken from receipt JSON `coverageUnit.id`. */
  const idsFromReceipts = new Set<string>();
  /**
   * Sanitized filename stems for receipts that lack coverageUnit.id.
   * Prefer body ids: a named receipt with an explicit unit must not also cover
   * an inventory unit that merely matches the filename.
   */
  const filenameKeys = new Set<string>();
  /** Raw stems used when a receipt has no coverageUnit.id (no-inventory mode). */
  const stemsWithoutId = new Set<string>();

  let entries: string[];
  try {
    entries = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }

  for (const name of entries) {
    const full = join(receiptsDir, name);
    const stem = basename(name, ".json");

    let unitId: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(full, "utf8")) as {
        coverageUnit?: { id?: string };
      };
      if (raw?.coverageUnit?.id && typeof raw.coverageUnit.id === "string") {
        unitId = raw.coverageUnit.id;
      }
    } catch {
      // unreadable receipt — fall through to filename heuristic
    }

    if (unitId) {
      idsFromReceipts.add(unitId);
    } else {
      filenameKeys.add(sanitizeForMatch(stem));
      stemsWithoutId.add(stem);
    }
  }

  if (inventory.length > 0) {
    const covered = new Set<string>();
    for (const unit of inventory) {
      if (idsFromReceipts.has(unit.id)) {
        covered.add(unit.id);
        continue;
      }
      // Filename heuristic: sanitized unit id matches a receipt filename stem
      if (filenameKeys.has(sanitizeForMatch(unit.id))) {
        covered.add(unit.id);
      }
    }
    const missingUnitIds = inventory.map((u) => u.id).filter((id) => !covered.has(id));
    return {
      pass,
      unitsTotal: inventory.length,
      unitsWithReceipt: covered.size,
      missingUnitIds,
      retryUnitIds: [],
    };
  }

  // No inventory: report unique unit ids discovered from receipts
  const found = new Set<string>([...idsFromReceipts, ...stemsWithoutId]);
  return {
    pass,
    unitsTotal: found.size,
    unitsWithReceipt: found.size,
    missingUnitIds: [],
    retryUnitIds: [],
  };
}

/**
 * True when an in-flight agent has not heartbeated / used a tool within `staleWarnMs`.
 * Terminal statuses are never stale.
 */
export function isAgentStale(agent: WikiAgentView, staleWarnMs: number, now: number = Date.now()): boolean {
  if (agent.status !== "running" && agent.status !== "waiting_tool" && agent.status !== "starting") {
    return false;
  }
  const ref = agent.lastHeartbeatAt ?? agent.lastTool?.at ?? agent.startedAt;
  if (ref === undefined) return true;
  return now - ref > staleWarnMs;
}

/** Collapse non-alphanumeric runs so `a::b/c` and `a-b-c` compare equal. */
export function sanitizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
