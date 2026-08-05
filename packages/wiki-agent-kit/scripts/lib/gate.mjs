/** Plan gates: coverage, semantic sufficiency, and digest-bound write authority. */

import fs from "node:fs";
import path from "node:path";
import { readJson, sha256File, writeJson } from "./artifacts.mjs";
import { verifyCheckpoint } from "./checkpoints.mjs";

export function gateReceiptPath(workdir) {
  return path.join(workdir, "inputs", "gate-plan.ok.json");
}

function artifactDigest(file) {
  return fs.existsSync(file) ? sha256File(file) : null;
}

function checkpointArtifact(checkpoint, relativePath) {
  return (checkpoint?.artifacts ?? []).find((artifact) => artifact?.path === relativePath) ?? null;
}

function assertCheckpointBinding(checkpoint, expectedPaths, label) {
  const errors = [];
  if (!checkpoint?.ok || checkpoint.checkpoint?.status !== "complete") {
    return [`valid ${label} checkpoint required`, ...(checkpoint?.errors ?? [])];
  }
  for (const expectedPath of expectedPaths) {
    if (!checkpointArtifact(checkpoint.checkpoint, expectedPath)) {
      errors.push(`${label} checkpoint does not declare ${expectedPath}`);
    }
  }
  return errors;
}

function cancellationEntries(spec) {
  return spec?.coverageCancellations ?? [];
}

function normalizedPagePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\")) return null;
  const normalized = value.replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..") || !normalized.endsWith(".md")) {
    return null;
  }
  return normalized;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/** Verify that the page ownership graph is complete and unambiguous. */
export function assertPageAssignments({ inventory, spec, assignments }) {
  const errors = [];
  const warnings = [];
  const pages = spec?.pages ?? [];
  if (!Array.isArray(assignments)) {
    return { ok: false, errors: ["missing analysis/page-assignments.json"], warnings };
  }
  const knownCoverage = new Set((inventory?.coverageUnits ?? []).map((unit) => unit?.id).filter(Boolean));
  const pageCoverage = new Map();
  for (const page of pages) {
    const pagePath = normalizedPagePath(page?.path);
    if (!pagePath) {
      errors.push(`Spec page has unsafe path: ${page?.path ?? "?"}`);
      continue;
    }
    if (pageCoverage.has(pagePath)) errors.push(`Spec repeats page path: ${pagePath}`);
    pageCoverage.set(pagePath, new Set(page.coverageUnitIds ?? []));
  }

  const assigned = new Set();
  const ownerPaths = new Map();
  for (const assignment of assignments) {
    const pagePath = normalizedPagePath(assignment?.pagePath);
    const owner = assignment?.owner;
    if (!pagePath || typeof owner !== "string" || !owner) {
      errors.push("page assignment requires a safe pagePath and non-empty owner");
      continue;
    }
    if (!pageCoverage.has(pagePath)) {
      errors.push(`page assignment references a page absent from Spec: ${pagePath}`);
    }
    if (assigned.has(pagePath)) errors.push(`page assignment duplicates path: ${pagePath}`);
    assigned.add(pagePath);
    if (!ownerPaths.has(owner)) ownerPaths.set(owner, new Set());
    ownerPaths.get(owner).add(pagePath);
    for (const coverageUnitId of assignment.coverageUnitIds ?? []) {
      if (!knownCoverage.has(coverageUnitId)) {
        errors.push(`page assignment ${pagePath} names unknown coverage unit: ${coverageUnitId}`);
      }
    }
    const expectedCoverage = pageCoverage.get(pagePath);
    if (expectedCoverage && !sameSet(expectedCoverage, new Set(assignment.coverageUnitIds ?? []))) {
      errors.push(`page assignment coverage differs from Spec page: ${pagePath}`);
    }
    if (assignment.role === "integration") {
      const page = pages.find((candidate) => normalizedPagePath(candidate?.path) === pagePath);
      const type = String(page?.type ?? "").toLowerCase();
      if (!(["overview", "flow", "concept"].includes(type) || pagePath.includes("flow") || pagePath.includes("glossary"))) {
        errors.push(`integration assignment must own overview, Flow, or glossary content: ${pagePath}`);
      }
    }
  }
  for (const pagePath of pageCoverage.keys()) {
    if (!assigned.has(pagePath)) errors.push(`Spec page has no page assignment: ${pagePath}`);
  }
  if (!ownerPaths.size) errors.push("page assignments are empty");
  return { ok: !errors.length, errors, warnings };
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
  const snapshotPath = path.join(workdir, "inputs", "snapshot-manifest.json");
  const analysisMapPath = path.join(workdir, "analysis", "discovery-map.json");
  const specPath = path.join(workdir, "analysis", "spec.json");
  const assignmentsPath = path.join(workdir, "analysis", "page-assignments.json");
  const discoverCheckpointPath = path.join(workdir, "analysis", "checkpoints", "discover.json");
  const inventory = readJson(inventoryPath);
  const discoveryMap = loadDiscoveryMap(workdir);
  const spec = readJson(specPath);
  const assignments = readJson(assignmentsPath);
  const coverage = assertCoverage({ inventory, spec, discoveryMap });
  const semantic = assertSemanticSufficiency({ inventory, spec, discoveryMap });
  const ownership = assertPageAssignments({ inventory, spec, assignments });
  const discoverCheckpoint = verifyCheckpoint(workdir, "discover");
  const digests = {
    inventory: artifactDigest(inventoryPath),
    snapshotManifest: artifactDigest(snapshotPath),
    discoveryMap: artifactDigest(analysisMapPath),
    spec: artifactDigest(specPath),
    assignments: artifactDigest(assignmentsPath),
    discoverCheckpoint: artifactDigest(discoverCheckpointPath),
  };
  const errors = [
    ...coverage.errors,
    ...semantic.errors,
    ...ownership.errors,
    ...assertCheckpointBinding(discoverCheckpoint, ["analysis/discovery-map.json"], "discover"),
  ];
  if (Object.entries(digests).some(([, digest]) => !digest)) errors.push("required planning artifact is missing");
  return {
    ok: !errors.length,
    coverage,
    semantic,
    ownership,
    digests,
    errors,
    warnings: [...coverage.warnings, ...semantic.warnings, ...ownership.warnings],
  };
}

export function writePlanGateReceipt(workdir, runId, methodDigest) {
  const result = gatePlan(workdir);
  const planCheckpoint = verifyCheckpoint(workdir, "plan");
  result.errors.push(
    ...assertCheckpointBinding(
      planCheckpoint,
      ["analysis/spec.json", "analysis/page-assignments.json"],
      "plan",
    ),
  );
  const discover = verifyCheckpoint(workdir, "discover");
  if (
    planCheckpoint.ok &&
    discover.ok &&
    planCheckpoint.checkpoint.inputCheckpointDigests?.[0] !== discover.checkpoint.checkpointDigest
  ) {
    result.errors.push("plan checkpoint is not bound to the discover checkpoint");
  }
  result.ok = result.errors.length === 0;
  const receiptPath = gateReceiptPath(workdir);
  fs.rmSync(receiptPath, { force: true });
  if (!result.ok) return { result, receipt: null };
  const receipt = {
    version: 2,
    ok: true,
    runId,
    methodDigest,
    digests: result.digests,
    planCheckpointDigest: planCheckpoint.checkpoint.checkpointDigest,
    at: new Date().toISOString(),
  };
  writeJson(receiptPath, receipt);
  return { result, receipt };
}

export function verifyPlanGate(workdir, runId, methodDigest) {
  const receipt = readJson(gateReceiptPath(workdir));
  if (!receipt?.ok) return { ok: false, errors: ["missing successful plan gate receipt"] };
  if (receipt.version !== 2 || receipt.runId !== runId || receipt.methodDigest !== methodDigest) {
    return { ok: false, errors: ["plan gate receipt belongs to another run or kit version"] };
  }
  const current = gatePlan(workdir);
  if (!current.ok) return { ok: false, errors: ["planning artifacts no longer pass the gate", ...current.errors] };
  for (const [name, digest] of Object.entries(current.digests)) {
    if (receipt.digests?.[name] !== digest) {
      return { ok: false, errors: [`plan gate receipt is stale: ${name} digest changed`] };
    }
  }
  const planCheckpoint = verifyCheckpoint(workdir, "plan");
  const planBindingErrors = assertCheckpointBinding(
    planCheckpoint,
    ["analysis/spec.json", "analysis/page-assignments.json"],
    "plan",
  );
  if (planBindingErrors.length) return { ok: false, errors: planBindingErrors };
  const discover = verifyCheckpoint(workdir, "discover");
  if (!discover.ok || discover.checkpoint.status !== "complete") {
    return { ok: false, errors: ["missing or invalid discover checkpoint", ...(discover.errors || [])] };
  }
  if (planCheckpoint.checkpoint.inputCheckpointDigests?.[0] !== discover.checkpoint.checkpointDigest) {
    return { ok: false, errors: ["plan checkpoint is not bound to the discover checkpoint"] };
  }
  if (receipt.planCheckpointDigest !== planCheckpoint.checkpoint.checkpointDigest) {
    return { ok: false, errors: ["plan gate receipt is bound to a different plan checkpoint"] };
  }
  return { ok: true, receipt, errors: [] };
}
