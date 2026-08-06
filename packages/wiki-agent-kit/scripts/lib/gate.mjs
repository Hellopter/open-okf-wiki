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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.some((item) => nonEmptyString(item));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flowHasEvidence(flow) {
  if (nonEmptyStringArray(flow?.evidenceIds)) return true;
  if (Array.isArray(flow?.evidence) && flow.evidence.some((item) => nonEmptyString(item?.path) || nonEmptyString(item))) {
    return true;
  }
  return false;
}

/**
 * Shared flow structure used by Discovery Map and Project Model.
 * Project Model steps also require a positive integer `order` (schema contract).
 * @param {object} flow
 * @param {{ requireStepOrder?: boolean }} [opts]
 */
function flowIsStructurallyComplete(flow, opts = {}) {
  const requireStepOrder = opts.requireStepOrder === true;
  if (!isObject(flow)) return false;
  if (!nonEmptyString(flow.id) || !nonEmptyString(flow.title)) return false;
  if (!nonEmptyString(flow.trigger) || !nonEmptyString(flow.outcome)) return false;
  if (!Array.isArray(flow.steps) || flow.steps.length < 1) return false;
  if (
    !flow.steps.every((step) => {
      if (!isObject(step) || !nonEmptyString(step.summary)) return false;
      if (!requireStepOrder) return true;
      return Number.isInteger(step.order) && step.order >= 1;
    })
  ) {
    return false;
  }
  if (!flowHasEvidence(flow)) return false;
  return true;
}

const PROJECT_MODEL_ID_COLLECTIONS = [
  "actors",
  "domains",
  "capabilities",
  "entities",
  "rules",
  "modules",
  "dataModels",
  "mappings",
  "conflicts",
  "gaps",
  "openQuestions",
];

function projectModelShapeErrors(projectModel) {
  const errors = [];
  if (!isObject(projectModel)) {
    return ["project-model.json must be a JSON object"];
  }
  if (!Number.isInteger(projectModel.version) || projectModel.version < 1) {
    errors.push("project-model.version must be an integer >= 1");
  }
  for (const key of [...PROJECT_MODEL_ID_COLLECTIONS, "flows"]) {
    if (!Array.isArray(projectModel[key])) {
      errors.push(`project-model.${key} must be an array`);
    }
  }
  if (!Object.hasOwn(projectModel, "productPurpose") || typeof projectModel.productPurpose !== "string") {
    errors.push("project-model.productPurpose must be a string");
  }
  for (const key of PROJECT_MODEL_ID_COLLECTIONS) {
    const items = projectModel[key];
    if (!Array.isArray(items)) continue;
    items.forEach((item, index) => {
      if (!isObject(item) || !nonEmptyString(item.id)) {
        errors.push(`project-model.${key}[${index}] lacks non-empty id`);
      }
    });
  }
  return errors;
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

/** @returns {{ ok: boolean, errors: string[], warnings: string[] }} */
export function assertSemanticSufficiency({ inventory, spec, discoveryMap, projectModel }) {
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
  if (tier !== "L0" && !domains.length) {
    errors.push("discovery-map has zero domains (semantic insufficiency)");
  }
  if (!spec || !(spec.pages ?? []).length) {
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
  }

  if (tier === "L0") {
    if (!projectModel) {
      warnings.push("no project-model (L0 soft)");
    } else {
      const shapeErrors = projectModelShapeErrors(projectModel);
      for (const error of shapeErrors) warnings.push(error);
      if (!nonEmptyString(projectModel.productPurpose)) {
        warnings.push("project-model.productPurpose is empty (L0 soft)");
      }
    }
  } else {
    if (!projectModel) {
      errors.push(`missing project-model.json for tier ${tier}`);
    } else {
      errors.push(...projectModelShapeErrors(projectModel));
      if (!nonEmptyString(projectModel.productPurpose)) {
        errors.push("project-model.productPurpose is empty");
      }
      const modelDomains = projectModel.domains ?? [];
      const modelCapabilities = projectModel.capabilities ?? [];
      if (!modelDomains.length && !modelCapabilities.length) {
        errors.push("project-model has neither domains nor capabilities");
      } else {
        if (!modelDomains.length) errors.push("project-model has zero domains");
        if (!modelCapabilities.length) errors.push("project-model has zero capabilities");
      }
      for (const flow of projectModel.flows ?? []) {
        // Project Model flows require schema step.order (positive integer).
        if (!flowIsStructurallyComplete(flow, { requireStepOrder: true })) {
          errors.push(`project-model flow is structurally incomplete: ${flow?.id ?? "?"}`);
        }
      }
      for (const flow of flows) {
        // Discovery Map flows keep the lighter step contract (summary only).
        if (!flowIsStructurallyComplete(flow, { requireStepOrder: false })) {
          errors.push(`discovery-map flow is structurally incomplete: ${flow?.id ?? flow?.title ?? "?"}`);
        }
      }
    }
  }

  for (const page of spec?.pages ?? []) {
    if (!isObject(page)) {
      errors.push("spec page must be an object");
      continue;
    }
    const critical = page.critical !== false;
    if (!critical) continue;
    const label = page.path ?? "?";
    if (!nonEmptyString(page.question)) {
      errors.push(`critical spec page lacks reader question: ${label}`);
    }
    if (!nonEmptyStringArray(page.requiredSections)) {
      errors.push(`critical spec page lacks requiredSections: ${label}`);
    }
    if (!nonEmptyStringArray(page.knowledgeIds)) {
      errors.push(`critical spec page lacks knowledgeIds: ${label}`);
    }
    if (!nonEmptyStringArray(page.evidenceIds)) {
      errors.push(`critical spec page lacks evidenceIds: ${label}`);
    }
  }

  return { ok: !errors.length, errors, warnings };
}

export function loadDiscoveryMap(workdir) {
  return readJson(path.join(workdir, "analysis", "discovery-map.json"));
}

export function loadProjectModel(workdir) {
  const file = path.join(workdir, "analysis", "project-model.json");
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

export function gatePlan(workdir) {
  const inventoryPath = path.join(workdir, "inputs", "inventory.json");
  const analysisMapPath = path.join(workdir, "analysis", "discovery-map.json");
  const projectModelPath = path.join(workdir, "analysis", "project-model.json");
  const specPath = path.join(workdir, "analysis", "spec.json");
  const inventory = readJson(inventoryPath);
  const discoveryMap = loadDiscoveryMap(workdir);
  const projectModel = loadProjectModel(workdir);
  const spec = readJson(specPath);
  const coverage = assertCoverage({ inventory, spec, discoveryMap });
  const semantic = assertSemanticSufficiency({ inventory, spec, discoveryMap, projectModel });
  const digests = {
    inventory: artifactDigest(inventoryPath),
    discoveryMap: artifactDigest(analysisMapPath),
    projectModel: artifactDigest(projectModelPath),
    spec: artifactDigest(specPath),
  };
  const errors = [...coverage.errors, ...semantic.errors];
  const tier = inventory?.tier ?? "L0";
  for (const [name, digest] of Object.entries(digests)) {
    if (digest) continue;
    if (name === "projectModel" && tier === "L0") continue;
    errors.push(`required planning artifact is missing: ${name}`);
  }
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
