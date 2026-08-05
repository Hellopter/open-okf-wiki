/** Plan gates: coverage, semantic sufficiency, and digest-bound write authority. */

import fs from "node:fs";
import path from "node:path";
import { readJson, sha256File, writeJson } from "./artifacts.mjs";

export function gateReceiptPath(workdir) {
  return path.join(workdir, "inputs", "gate-plan.ok.json");
}

function artifactDigest(file) {
  return fs.existsSync(file) ? sha256File(file) : null;
}

function cancellationEntries(spec) {
  return spec?.coverageCancellations ?? [];
}

/** @returns {{ ok: boolean, errors: string[], warnings: string[] }} */
export function assertCoverage({ inventory, spec, discoveryMap }) {
  const errors = [];
  const warnings = [];
  const units = inventory?.coverageUnits ?? discoveryMap?.coverageUnits ?? [];
  const required = units.filter((unit) => unit.required !== false);
  if (!required.length) {
    warnings.push("no coverage units in inventory");
    return { ok: true, errors, warnings };
  }
  if (!spec) {
    errors.push("missing spec.json - cannot assert coverage");
    return { ok: false, errors, warnings };
  }

  const known = new Set(units.map((unit) => unit.id));
  const bound = new Set();
  for (const page of spec.pages ?? []) {
    for (const id of page.coverageUnitIds ?? []) bound.add(id);
  }
  for (const domain of spec.domains ?? []) {
    for (const id of domain.coverageUnitIds ?? []) bound.add(id);
  }

  const cancelled = new Set();
  for (const entry of cancellationEntries(spec)) {
    if (!entry.cancelled) continue;
    const id = entry.coverageUnitId;
    const reason = entry.reason ?? entry.notes;
    if (typeof id !== "string" || !known.has(id)) {
      errors.push(`cancellation names an unknown coverage unit: ${id ?? "?"}`);
    } else if (typeof reason !== "string" || !reason.trim()) {
      errors.push(`cancelled coverage requires a non-empty reason: ${id}`);
    } else {
      cancelled.add(id);
    }
  }

  for (const unit of required) {
    if (!bound.has(unit.id) && !cancelled.has(unit.id)) {
      errors.push(`coverage unit not bound or cancelled: ${unit.id}`);
    }
  }
  return { ok: !errors.length, errors, warnings };
}

function sourceIdsFromInventory(inventory, discoveryMap) {
  const fromInventory = (inventory?.sources ?? [])
    .map((source) => source?.sourceId ?? source?.id)
    .filter((id) => typeof id === "string" && id);
  if (fromInventory.length) return [...new Set(fromInventory)];
  const fromUnits = (inventory?.coverageUnits ?? discoveryMap?.coverageUnits ?? [])
    .map((unit) => unit?.sourceId)
    .filter((id) => typeof id === "string" && id);
  if (fromUnits.length) return [...new Set(fromUnits)];
  const fromMap = (discoveryMap?.sources ?? [])
    .map((source) => source?.sourceId ?? source?.id)
    .filter((id) => typeof id === "string" && id);
  return [...new Set(fromMap)];
}

function pageBindsSource(page, sourceId) {
  const ids = page?.coverageUnitIds ?? [];
  return ids.some((id) => id === sourceId || String(id).startsWith(`${sourceId}::`));
}

/** @returns {{ ok: boolean, errors: string[], warnings: string[] }} */
export function assertSemanticSufficiency({ inventory, spec, discoveryMap }) {
  const errors = [];
  const warnings = [];
  const tier = inventory?.tier ?? "L0";
  const sourceCount = inventory?.sourceCount ?? discoveryMap?.sources?.length ?? 0;
  if (!discoveryMap) {
    if (tier === "L0") {
      warnings.push("no discovery-map (L0 soft)");
      return { ok: true, errors, warnings };
    }
    errors.push(`missing discovery-map.json for tier ${tier}`);
    return { ok: false, errors, warnings };
  }

  const domains = discoveryMap.domains ?? [];
  const flows = discoveryMap.flows ?? [];
  const pages = spec?.pages ?? [];
  if (tier !== "L0" && !domains.length) {
    errors.push("discovery-map has zero domains (semantic insufficiency)");
  }
  if (!spec || !pages.length) {
    errors.push("spec has zero pages");
  }

  if (sourceCount >= 2) {
    const hasCrossFlow = flows.some((flow) => flow.crossSource === true);
    const hasMultiUnitDomain = domains.some((domain) => (domain.coverageUnitIds ?? []).length > 1);
    const cancellation = spec?.crossSourceFlowCancellation;
    const cancelled =
      cancellation?.cancelled === true && typeof cancellation.reason === "string" && cancellation.reason.trim();
    if (!hasCrossFlow && !hasMultiUnitDomain && !cancelled) {
      errors.push("multi-source run lacks cross-source flow, multi-unit domain, or explicit cancellation");
    }

    // Deep multi-source plan: require enough pages and per-source binding so the wiki cannot
    // collapse into a single thin overview.
    if (pages.length) {
      const minPages = Math.max(3, sourceCount + 1);
      if (pages.length < minPages) {
        errors.push(
          `multi-source run needs deeper Spec (at least ${minPages} pages including overview + per-source coverage); found ${pages.length}`,
        );
      }
      const sourceIds = sourceIdsFromInventory(inventory, discoveryMap);
      for (const sourceId of sourceIds) {
        const bound = pages.some((page) => pageBindsSource(page, sourceId));
        if (!bound) {
          errors.push(`multi-source Spec does not bind source "${sourceId}" to any page coverageUnitIds`);
        }
      }
      const hasCriticalCrossFlowPage = pages.some((page) => {
        if (page?.critical !== true) return false;
        const type = String(page?.type ?? "").toLowerCase();
        const path = String(page?.path ?? "").toLowerCase();
        const title = String(page?.title ?? "").toLowerCase();
        const looksLikeFlow = type === "flow" || path.includes("flow") || title.includes("flow");
        const multiBound = (page?.coverageUnitIds ?? []).length > 1;
        return looksLikeFlow || multiBound;
      });
      if (!hasCriticalCrossFlowPage && !cancelled) {
        errors.push(
          "multi-source Spec lacks a critical cross-source Flow (or multi-unit) page; cancel with crossSourceFlowCancellation if intentional",
        );
      }
    }
  }
  return { ok: !errors.length, errors, warnings };
}

export function loadDiscoveryMap(workdir) {
  return readJson(path.join(workdir, "analysis", "discovery-map.json"));
}

export function gatePlan(workdir) {
  const inventoryPath = path.join(workdir, "inputs", "inventory.json");
  const analysisMapPath = path.join(workdir, "analysis", "discovery-map.json");
  const specPath = path.join(workdir, "analysis", "spec.json");
  const inventory = readJson(inventoryPath);
  const discoveryMap = loadDiscoveryMap(workdir);
  const spec = readJson(specPath);
  const coverage = assertCoverage({ inventory, spec, discoveryMap });
  const semantic = assertSemanticSufficiency({ inventory, spec, discoveryMap });
  const digests = {
    inventory: artifactDigest(inventoryPath),
    discoveryMap: artifactDigest(analysisMapPath),
    spec: artifactDigest(specPath),
  };
  const errors = [...coverage.errors, ...semantic.errors];
  if (Object.entries(digests).some(([, digest]) => !digest)) errors.push("required planning artifact is missing");
  return {
    ok: !errors.length,
    coverage,
    semantic,
    digests,
    errors,
    warnings: [...coverage.warnings, ...semantic.warnings],
  };
}

export function writePlanGateReceipt(workdir, runId, kitDigest) {
  const result = gatePlan(workdir);
  const receiptPath = gateReceiptPath(workdir);
  fs.rmSync(receiptPath, { force: true });
  if (!result.ok) return { result, receipt: null };
  const receipt = {
    version: 1,
    ok: true,
    runId,
    kitDigest,
    digests: result.digests,
    at: new Date().toISOString(),
  };
  writeJson(receiptPath, receipt);
  return { result, receipt };
}

export function verifyPlanGate(workdir, runId, kitDigest) {
  const receipt = readJson(gateReceiptPath(workdir));
  if (!receipt?.ok) return { ok: false, errors: ["missing successful plan gate receipt"] };
  if (receipt.version !== 1 || receipt.runId !== runId || receipt.kitDigest !== kitDigest) {
    return { ok: false, errors: ["plan gate receipt belongs to another run or kit version"] };
  }
  const current = gatePlan(workdir);
  if (!current.ok) return { ok: false, errors: ["planning artifacts no longer pass the gate", ...current.errors] };
  for (const [name, digest] of Object.entries(current.digests)) {
    if (receipt.digests?.[name] !== digest) {
      return { ok: false, errors: [`plan gate receipt is stale: ${name} digest changed`] };
    }
  }
  return { ok: true, receipt, errors: [] };
}
