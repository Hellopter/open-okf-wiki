/** Survey receipt validation and deterministic discovery-map reduction. */

import fs from "node:fs";
import path from "node:path";
import { isInside, readJson, stableJson, writeJson } from "./artifacts.mjs";

export const SURVEY_RECEIPT_VERSION = 1;
export const SURVEY_RECEIPT_KIND = "survey-receipt";
export const SURVEY_MERGE_ARTIFACT_KIND = "survey-merge";
export const MAX_SURVEY_RECEIPT_BYTES = 48 * 1024;

const MAX = {
  entryPoints: 16,
  modules: 24,
  runtimeFlows: 8,
  contracts: 16,
  evidence: 16,
  domains: 12,
  flows: 8,
  openQuestions: 6,
};

const RECEIPT_KEYS = new Set([
  "version",
  "kind",
  "coverageUnit",
  "status",
  "purpose",
  "summary",
  "entryPoints",
  "modules",
  "runtimeFlows",
  "contracts",
  "evidence",
  "plannerHints",
  "openQuestions",
  "insufficiency",
  "relatedCoverageUnitIds",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function serializedByteLength(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizedRelative(value) {
  if (!isNonEmptyString(value) || value.includes("\\") || path.posix.isAbsolute(value)) return null;
  const normalized = value.replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function lineCount(file) {
  const contents = fs.readFileSync(file, "utf8");
  if (!contents) return 0;
  const lines = contents.split(/\r\n|\n|\r/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function assertKnownKeys(value, allowed, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unsupported field: ${key}`);
  }
  return true;
}

function assertFindingList(value, label, max, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (value.length > max) errors.push(`${label} exceeds maximum of ${max}`);
  const ids = new Set();
  for (const [index, finding] of value.entries()) {
    const item = `${label}[${index}]`;
    if (!assertKnownKeys(finding, new Set(["id", "summary", "evidenceIds"]), item, errors)) continue;
    if (!isNonEmptyString(finding.id) || !isNonEmptyString(finding.summary)) {
      errors.push(`${item} requires id and summary`);
    }
    if (ids.has(finding.id)) errors.push(`${label} has duplicate id: ${finding.id}`);
    ids.add(finding.id);
    if (finding.evidenceIds !== undefined && (!Array.isArray(finding.evidenceIds) || finding.evidenceIds.some((id) => !isNonEmptyString(id)))) {
      errors.push(`${item}.evidenceIds must be an array of non-empty strings`);
    }
  }
}

function assertHintList(value, label, max, knownUnitIds, errors, { flow = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (value.length > max) errors.push(`${label} exceeds maximum of ${max}`);
  const ids = new Set();
  for (const [index, hint] of value.entries()) {
    const item = `${label}[${index}]`;
    const allowed = new Set(["id", "summary", "evidenceIds", "coverageUnitIds", ...(flow ? ["crossSource"] : [])]);
    if (!assertKnownKeys(hint, allowed, item, errors)) continue;
    if (!isNonEmptyString(hint.id) || !isNonEmptyString(hint.summary)) errors.push(`${item} requires id and summary`);
    if (ids.has(hint.id)) errors.push(`${label} has duplicate id: ${hint.id}`);
    ids.add(hint.id);
    if (hint.evidenceIds !== undefined && (!Array.isArray(hint.evidenceIds) || hint.evidenceIds.some((id) => !isNonEmptyString(id)))) {
      errors.push(`${item}.evidenceIds must be an array of non-empty strings`);
    }
    if (hint.coverageUnitIds !== undefined) {
      if (!Array.isArray(hint.coverageUnitIds) || hint.coverageUnitIds.some((id) => !knownUnitIds.has(id))) {
        errors.push(`${item}.coverageUnitIds must name known coverage units`);
      }
    }
    if (flow && hint.crossSource !== undefined && typeof hint.crossSource !== "boolean") {
      errors.push(`${item}.crossSource must be boolean`);
    }
  }
}

function assertCoverageUnit(receiptUnit, inventoryUnit, errors) {
  const label = "coverageUnit";
  if (!assertKnownKeys(receiptUnit, new Set(["id", "kind", "sourceId", "path", "label"]), label, errors)) return;
  for (const key of ["id", "kind", "sourceId", "path", "label"]) {
    if (!isNonEmptyString(receiptUnit[key])) errors.push(`${label}.${key} must be a non-empty string`);
    if (receiptUnit[key] !== inventoryUnit?.[key]) errors.push(`${label}.${key} does not match inventory`);
  }
}

function assertEvidence(value, unit, workdir, errors) {
  if (!Array.isArray(value)) {
    errors.push("evidence must be an array");
    return;
  }
  if (value.length > MAX.evidence) errors.push(`evidence exceeds maximum of ${MAX.evidence}`);
  const ids = new Set();
  const sourcePrefix = `sources/${unit.sourceId}`;
  const allowedPrefix = unit.kind === "surface"
    ? `${sourcePrefix}/${unit.path.replace(/^\.\//, "").replace(/\/$/, "")}`
    : sourcePrefix;
  for (const [index, evidence] of value.entries()) {
    const item = `evidence[${index}]`;
    if (!assertKnownKeys(evidence, new Set(["id", "path", "startLine", "endLine", "summary"]), item, errors)) continue;
    const relative = normalizedRelative(evidence.path);
    if (!isNonEmptyString(evidence.id) || !relative || !isNonEmptyString(evidence.summary)) {
      errors.push(`${item} requires id, source-relative path, and summary`);
      continue;
    }
    if (ids.has(evidence.id)) errors.push(`evidence has duplicate id: ${evidence.id}`);
    ids.add(evidence.id);
    const inSource = relative === sourcePrefix || relative.startsWith(`${sourcePrefix}/`);
    const inUnit = relative === allowedPrefix || relative.startsWith(`${allowedPrefix}/`);
    if (!inSource || !inUnit) {
      errors.push(`${item}.path escapes coverage unit: ${relative}`);
      continue;
    }
    if (!Number.isInteger(evidence.startLine) || !Number.isInteger(evidence.endLine) || evidence.startLine < 1 || evidence.endLine < evidence.startLine) {
      errors.push(`${item} has invalid line range`);
      continue;
    }
    const absolute = path.resolve(workdir, relative);
    if (!isInside(workdir, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      errors.push(`${item}.path does not name a frozen regular file: ${relative}`);
      continue;
    }
    const count = lineCount(absolute);
    if (evidence.endLine > count) errors.push(`${item} line range exceeds file length: ${relative}`);
  }
}

function assertInsufficiency(receipt, errors) {
  if (receipt.status === "ok") {
    if (receipt.insufficiency !== undefined) errors.push("ok receipt must not include insufficiency");
    return;
  }
  const value = receipt.insufficiency;
  if (!isObject(value)) {
    errors.push("non-ok receipt requires insufficiency");
    return;
  }
  if (!assertKnownKeys(value, new Set(["code", "retryable", "reason"]), "insufficiency", errors)) return;
  const codes = new Set(["rate_limited", "timeout", "snapshot_missing", "access_denied", "unsupported", "no_evidence", "other"]);
  if (!codes.has(value.code) || typeof value.retryable !== "boolean" || !isNonEmptyString(value.reason)) {
    errors.push("insufficiency requires code, retryable, and reason");
  }
}

/**
 * Survey workers write only the data plane. The host owns the control
 * envelope so a worker can neither choose nor accidentally copy it.
 */
function materializeSurveyReceipt(value) {
  if (!isObject(value)) return { ok: false, errors: ["survey receipt must be an object"] };
  const errors = [];
  if (Object.hasOwn(value, "version") || Object.hasOwn(value, "kind")) {
    errors.push("survey worker receipt must not contain host-controlled envelope fields");
  }
  return {
    ok: !errors.length,
    errors,
    receipt: {
      version: SURVEY_RECEIPT_VERSION,
      kind: SURVEY_RECEIPT_KIND,
      ...value,
    },
  };
}

/** Validate one parsed receipt against frozen evidence and an inventory. */
export function assertSurveyReceipt({ workdir, inventory, receipt, receiptPath }) {
  const errors = [];
  if (!assertKnownKeys(receipt, RECEIPT_KEYS, "survey receipt", errors)) return { ok: false, errors };
  if (receipt.version !== SURVEY_RECEIPT_VERSION) errors.push(`survey receipt version must be ${SURVEY_RECEIPT_VERSION}`);
  if (receipt.kind !== SURVEY_RECEIPT_KIND) errors.push(`survey receipt kind must be ${SURVEY_RECEIPT_KIND}`);
  if (!new Set(["ok", "failed", "skipped"]).has(receipt.status)) errors.push("survey receipt status must be ok, failed, or skipped");
  if (!isNonEmptyString(receipt.purpose) || !isNonEmptyString(receipt.summary)) {
    errors.push("survey receipt requires non-empty purpose and summary");
  }
  const bytes = receiptPath && fs.existsSync(receiptPath)
    ? fs.statSync(receiptPath).size
    : serializedByteLength(receipt);
  if (bytes > MAX_SURVEY_RECEIPT_BYTES) {
    errors.push(`survey receipt exceeds ${MAX_SURVEY_RECEIPT_BYTES} bytes`);
  }
  const inventoryUnits = inventory?.coverageUnits;
  if (!Array.isArray(inventoryUnits)) {
    errors.push("inventory has no coverageUnits");
    return { ok: false, errors };
  }
  const unit = inventoryUnits.find((candidate) => candidate?.id === receipt.coverageUnit?.id);
  if (!unit) errors.push(`receipt names unknown coverage unit: ${receipt.coverageUnit?.id ?? "?"}`);
  else assertCoverageUnit(receipt.coverageUnit, unit, errors);

  assertFindingList(receipt.entryPoints, "entryPoints", MAX.entryPoints, errors);
  assertFindingList(receipt.modules, "modules", MAX.modules, errors);
  assertFindingList(receipt.runtimeFlows, "runtimeFlows", MAX.runtimeFlows, errors);
  assertFindingList(receipt.contracts, "contracts", MAX.contracts, errors);
  const knownUnitIds = new Set(inventoryUnits.map((candidate) => candidate?.id).filter(isNonEmptyString));
  if (!assertKnownKeys(receipt.plannerHints, new Set(["domains", "flows"]), "plannerHints", errors)) {
    // The child fields cannot be validated after a malformed envelope.
  } else {
    assertHintList(receipt.plannerHints.domains, "plannerHints.domains", MAX.domains, knownUnitIds, errors);
    assertHintList(receipt.plannerHints.flows, "plannerHints.flows", MAX.flows, knownUnitIds, errors, { flow: true });
  }
  if (!Array.isArray(receipt.openQuestions) || receipt.openQuestions.length > MAX.openQuestions || receipt.openQuestions.some((item) => !isNonEmptyString(item))) {
    errors.push(`openQuestions must contain at most ${MAX.openQuestions} non-empty strings`);
  }
  if (unit) assertEvidence(receipt.evidence, unit, workdir, errors);
  else if (!Array.isArray(receipt.evidence)) errors.push("evidence must be an array");
  if (receipt.status === "ok" && (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0)) {
    errors.push("ok receipt requires at least one evidence entry");
  }
  assertInsufficiency(receipt, errors);

  if (unit?.kind === "source") {
    const expected = inventoryUnits
      .filter((candidate) => candidate?.kind === "surface" && candidate.sourceId === unit.sourceId)
      .map((candidate) => candidate.id)
      .sort();
    const actual = Array.isArray(receipt.relatedCoverageUnitIds) ? [...receipt.relatedCoverageUnitIds].sort() : null;
    if (!actual || actual.some((id) => !isNonEmptyString(id)) || new Set(actual).size !== actual.length || !sameArray(actual, expected)) {
      errors.push("source receipt relatedCoverageUnitIds must exactly list its child surfaces");
    }
  } else if (receipt.relatedCoverageUnitIds !== undefined) {
    errors.push("surface receipt must not include relatedCoverageUnitIds");
  }

  return { ok: !errors.length, errors, receipt, unit };
}

function relativeReceiptPath(workdir, value, { hostOwned = false } = {}) {
  const relative = normalizedRelative(value);
  const prefix = hostOwned ? "analysis/receipts/survey-host/" : "analysis/receipts/survey/";
  if (!relative || !relative.startsWith(prefix)) return null;
  const absolute = path.resolve(workdir, relative);
  if (!isInside(workdir, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  return { relative, absolute };
}

function artifactIntent(artifact) {
  return {
    id: artifact?.id,
    type: artifact?.type,
    path: artifact?.path,
    ...(Array.isArray(artifact?.coverageUnitIds) && artifact.coverageUnitIds.length
      ? { coverageUnitIds: artifact.coverageUnitIds }
      : {}),
  };
}

function sameArtifactIntents(left, right) {
  return stableJson(left.map(artifactIntent)) === stableJson(right.map(artifactIntent));
}

function surveyMergePass(value) {
  const relative = normalizedRelative(value);
  const match = relative && /^analysis\/receipts\/discovery-artifacts-pass-(\d+)\.json$/.exec(relative);
  return match ? Number(match[1]) : null;
}

function discoveryArtifacts({ selected, labelsRelative, artifactsPath }) {
  return [
    { id: "discovery-map", type: "discovery-map", path: "analysis/discovery-map.json" },
    ...selected.map((record) => ({
      id: `survey:${record.receipt.coverageUnit.id}`,
      type: SURVEY_RECEIPT_KIND,
      path: record.path,
      coverageUnitIds: [record.receipt.coverageUnit.id],
    })),
    ...(labelsRelative ? [{ id: "discovery-labels", type: "discovery-labels", path: labelsRelative }] : []),
    { id: "survey-merge", type: SURVEY_MERGE_ARTIFACT_KIND, path: artifactsPath },
  ];
}

/** Validate that discover artifacts bind exactly one valid survey receipt per required unit. */
export function assertDiscoverSurveyQuality(workdir, artifacts) {
  const errors = [];
  const inventory = readJson(path.join(workdir, "inputs", "inventory.json"));
  if (!Array.isArray(inventory?.coverageUnits)) return { ok: false, errors: ["discover quality requires inventory coverageUnits"], receipts: [] };
  if (!Array.isArray(artifacts)) return { ok: false, errors: ["discover quality requires an artifact array"], receipts: [] };
  const mergeArtifacts = artifacts.filter((artifact) => artifact?.type === SURVEY_MERGE_ARTIFACT_KIND);
  if (mergeArtifacts.length !== 1) errors.push("discover artifacts require exactly one survey-merge artifact");
  let mergePass = null;
  if (mergeArtifacts.length === 1) {
    const mergeArtifact = mergeArtifacts[0];
    mergePass = surveyMergePass(mergeArtifact.path);
    const relative = normalizedRelative(mergeArtifact.path);
    const absolute = relative && path.resolve(workdir, relative);
    if (!mergePass || !relative || !isInside(workdir, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      errors.push(`survey-merge artifact has unsafe path: ${mergeArtifact?.path ?? "?"}`);
      mergePass = null;
    } else {
      try {
        const declared = readJson(absolute);
        if (!Array.isArray(declared) || !sameArtifactIntents(declared, artifacts)) {
          errors.push("discover artifacts do not match the host survey-merge artifact list");
        }
      } catch (error) {
        errors.push(`survey-merge artifact cannot be parsed: ${relative}: ${error.message}`);
        mergePass = null;
      }
    }
  }
  const mapArtifacts = artifacts.filter((artifact) => artifact?.type === "discovery-map" && artifact.path === "analysis/discovery-map.json");
  if (mapArtifacts.length !== 1) errors.push("discover artifacts require exactly one analysis/discovery-map.json artifact");
  const labels = artifacts.filter((artifact) => artifact?.type === "discovery-labels");
  if (labels.length > 1) errors.push("discover artifacts may contain only one discovery-labels artifact");
  const receiptArtifacts = artifacts.filter((artifact) => artifact?.type === SURVEY_RECEIPT_KIND);
  const byUnit = new Map();
  const receipts = [];
  for (const artifact of receiptArtifacts) {
    const file = relativeReceiptPath(workdir, artifact.path, { hostOwned: true });
    if (!file) {
      errors.push(`survey receipt artifact has unsafe path: ${artifact?.path ?? "?"}`);
      continue;
    }
    let receipt;
    try {
      receipt = readJson(file.absolute);
    } catch (error) {
      errors.push(`survey receipt cannot be parsed: ${file.relative}: ${error.message}`);
      continue;
    }
    const result = assertSurveyReceipt({ workdir, inventory, receipt, receiptPath: file.absolute });
    if (!result.ok) {
      errors.push(...result.errors.map((error) => `${file.relative}: ${error}`));
      continue;
    }
    const declared = artifact.coverageUnitIds ?? [];
    if (!Array.isArray(declared) || declared.length !== 1 || declared[0] !== receipt.coverageUnit.id) {
      errors.push(`${file.relative}: artifact coverageUnitIds must contain exactly its receipt coverage unit`);
      continue;
    }
    if (byUnit.has(receipt.coverageUnit.id)) {
      errors.push(`discover artifacts bind multiple survey receipts for unit: ${receipt.coverageUnit.id}`);
      continue;
    }
    const record = {
      artifact,
      receipt,
      unit: result.unit,
      path: file.relative,
      pass: parsePassFromName(file.relative),
    };
    byUnit.set(receipt.coverageUnit.id, record);
    receipts.push(record);
  }
  for (const unit of inventory.coverageUnits.filter((candidate) => candidate?.required === true)) {
    if (!byUnit.has(unit.id)) errors.push(`required coverage unit has no valid survey receipt: ${unit.id}`);
  }
  let normalizedLabels = null;
  if (labels.length === 1) {
    const relative = normalizedRelative(labels[0].path);
    const absolute = relative && path.resolve(workdir, relative);
    if (!relative || !relative.startsWith("analysis/receipts/") || !isInside(workdir, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      errors.push(`discovery labels artifact has unsafe path: ${labels[0]?.path ?? "?"}`);
    } else {
      try {
        const validated = normalizeLabels(workdir, readJson(absolute), inventory);
        if (!validated.ok) errors.push(...validated.errors.map((error) => `${relative}: ${error}`));
        else normalizedLabels = validated.labels;
      } catch (error) {
        errors.push(`discovery labels cannot be parsed: ${relative}: ${error.message}`);
      }
    }
  }
  if (mergePass !== null) {
    const expectedSelection = selectLatestSurveyReceipts(workdir, inventory, mergePass).selected;
    const newestSelection = selectLatestSurveyReceipts(workdir, inventory, Number.MAX_SAFE_INTEGER).selected;
    const newestPass = Math.max(0, ...newestSelection.map((record) => record.pass));
    if (mergePass < newestPass) {
      errors.push(`survey-merge artifact is stale at pass ${mergePass}; valid worker receipts exist through pass ${newestPass}`);
    }
    const expectedArtifacts = discoveryArtifacts({
      selected: expectedSelection.map((record) => ({ ...record, path: hostReceiptPath(record.receipt, record.pass) })),
      labelsRelative: labels.length === 1 ? labels[0].path : null,
      artifactsPath: mergeArtifacts[0].path,
    });
    if (!sameArtifactIntents(expectedArtifacts, artifacts)) {
      errors.push("discover artifacts are not the deterministic selection from survey worker receipts");
    }
    const expectedByUnit = new Map(expectedSelection.map((record) => [record.receipt.coverageUnit.id, record]));
    for (const record of receipts) {
      const expected = expectedByUnit.get(record.receipt.coverageUnit.id);
      if (!expected || stableJson(record.receipt) !== stableJson(expected.receipt)) {
        errors.push(`survey receipt differs from the host materialization for unit: ${record.receipt.coverageUnit.id}`);
      }
    }
  }
  if (mapArtifacts.length === 1) {
    const map = readJson(path.join(workdir, "analysis", "discovery-map.json"));
    const expected = buildDiscoveryMap(inventory, receipts, normalizedLabels);
    if (!isObject(map) || stableJson(map) !== stableJson(expected)) {
      errors.push("discovery-map is not the deterministic merge of selected survey receipts");
    }
  }
  return { ok: !errors.length, errors, receipts, inventory };
}

function parsePassFromName(relative) {
  const match = /-pass-(\d+)\.json$/.exec(relative);
  return match ? Number(match[1]) : null;
}

function listReceiptFiles(workdir) {
  const directory = path.join(workdir, "analysis", "receipts", "survey");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `analysis/receipts/survey/${entry.name}`)
    .sort();
}

function hostReceiptPath(receipt, pass) {
  return `analysis/receipts/survey-host/${encodeURIComponent(receipt.coverageUnit.id)}-pass-${pass}.json`;
}

function selectLatestSurveyReceipts(workdir, inventory, requestedPass) {
  const latest = new Map();
  const invalid = new Map();
  for (const relative of listReceiptFiles(workdir)) {
    const receiptPass = parsePassFromName(relative);
    if (!receiptPass || receiptPass > requestedPass) continue;
    const absolute = path.join(workdir, relative);
    let rawReceipt;
    try {
      rawReceipt = readJson(absolute);
    } catch (error) {
      invalid.set(relative, error.message);
      continue;
    }
    const materialized = materializeSurveyReceipt(rawReceipt);
    if (!materialized.ok) {
      invalid.set(relative, materialized.errors.join("; "));
      continue;
    }
    const receipt = materialized.receipt;
    const result = assertSurveyReceipt({ workdir, inventory, receipt, receiptPath: absolute });
    if (serializedByteLength(receipt) > MAX_SURVEY_RECEIPT_BYTES) {
      result.ok = false;
      result.errors.push(`survey receipt exceeds ${MAX_SURVEY_RECEIPT_BYTES} bytes after host envelope`);
    }
    if (!result.ok) {
      invalid.set(relative, result.errors.join("; "));
      continue;
    }
    const current = latest.get(receipt.coverageUnit.id);
    if (!current || receiptPass > current.pass || (receiptPass === current.pass && relative.localeCompare(current.path) < 0)) {
      latest.set(receipt.coverageUnit.id, { receipt, unit: result.unit, pass: receiptPass, path: relative });
    }
  }
  const selected = inventory.coverageUnits
    .map((unit) => latest.get(unit.id))
    .filter(Boolean)
    .sort((left, right) => left.receipt.coverageUnit.id.localeCompare(right.receipt.coverageUnit.id));
  return { latest, invalid, selected };
}

function mergeHints(receipts, field) {
  const values = new Map();
  for (const record of receipts) {
    for (const hint of record.receipt.plannerHints[field] ?? []) {
      const coverageUnitIds = [...new Set([...(hint.coverageUnitIds ?? []), record.receipt.coverageUnit.id])].sort();
      const current = values.get(hint.id);
      if (!current) {
        values.set(hint.id, {
          id: hint.id,
          summary: hint.summary,
          ...(field === "flows" && hint.crossSource !== undefined ? { crossSource: hint.crossSource } : {}),
          coverageUnitIds,
        });
      } else {
        current.coverageUnitIds = [...new Set([...current.coverageUnitIds, ...coverageUnitIds])].sort();
        if (field === "flows") current.crossSource ||= hint.crossSource === true;
      }
    }
  }
  return [...values.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildDiscoveryMap(inventory, selected, labels) {
  const domains = labels?.domains ?? mergeHints(selected, "domains");
  const flows = labels?.flows ?? mergeHints(selected, "flows");
  return {
    version: 1,
    coverageUnits: inventory.coverageUnits,
    ledger: selected.map((record) => ({
      coverageUnitId: record.receipt.coverageUnit.id,
      status: record.receipt.status,
      receiptPath: record.path,
      pass: record.pass,
      ...(record.receipt.insufficiency ? { insufficiency: record.receipt.insufficiency } : {}),
    })),
    domains,
    flows,
    concepts: [],
    openQuestions: selected.flatMap((record) => record.receipt.openQuestions).slice(0, MAX.openQuestions),
  };
}

function normalizeLabels(workdir, value, inventory) {
  if (!value) return { ok: true, labels: null, errors: [] };
  const errors = [];
  if (!isObject(value) || !Array.isArray(value.domains) || !Array.isArray(value.flows)) {
    return { ok: false, labels: null, errors: ["discovery labels require domains and flows arrays"] };
  }
  const known = new Set(inventory.coverageUnits.map((unit) => unit.id));
  assertHintList(value.domains, "labels.domains", MAX.domains, known, errors);
  assertHintList(value.flows, "labels.flows", MAX.flows, known, errors, { flow: true });
  const labels = {
    domains: value.domains.map((hint) => ({ id: hint.id, summary: hint.summary, coverageUnitIds: [...new Set(hint.coverageUnitIds ?? [])].sort() })),
    flows: value.flows.map((hint) => ({ id: hint.id, summary: hint.summary, ...(hint.crossSource !== undefined ? { crossSource: hint.crossSource } : {}), coverageUnitIds: [...new Set(hint.coverageUnitIds ?? [])].sort() })),
  };
  return { ok: !errors.length, labels, errors };
}

/**
 * Select validated latest receipts and write the deterministic Discovery Map.
 * This command never invents missing evidence; invalid/absent receipts remain missing.
 */
export function mergeSurveyReceipts(workdir, { pass, labelsPath } = {}) {
  const inventory = readJson(path.join(workdir, "inputs", "inventory.json"));
  if (!Array.isArray(inventory?.coverageUnits)) throw new Error("survey-merge requires inputs/inventory.json coverageUnits");
  const requestedPass = Number(pass);
  if (!Number.isInteger(requestedPass) || requestedPass < 1) throw new Error("survey-merge requires a positive --pass");
  const { latest, invalid, selected } = selectLatestSurveyReceipts(workdir, inventory, requestedPass);
  for (const record of selected) {
    record.path = hostReceiptPath(record.receipt, record.pass);
    writeJson(path.join(workdir, record.path), record.receipt);
  }
  const missingUnitIds = [];
  const retryUnitIds = [];
  for (const unit of inventory.coverageUnits.filter((candidate) => candidate.required === true)) {
    const record = latest.get(unit.id);
    if (!record) {
      missingUnitIds.push(unit.id);
      retryUnitIds.push(unit.id);
    } else if (record.receipt.status !== "ok" && record.receipt.insufficiency.retryable) {
      missingUnitIds.push(unit.id);
      retryUnitIds.push(unit.id);
    }
  }
  let labels = null;
  let labelsRelative = null;
  if (labelsPath) {
    const relative = normalizedRelative(labelsPath);
    const absolute = relative && path.resolve(workdir, relative);
    if (!relative || !isInside(workdir, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`survey-merge labels path is not a run-local file: ${labelsPath}`);
    }
    const validated = normalizeLabels(workdir, readJson(absolute), inventory);
    if (!validated.ok) throw new Error(`survey-merge labels are invalid: ${validated.errors.join("; ")}`);
    labels = validated.labels;
    labelsRelative = relative;
  }
  const map = buildDiscoveryMap(inventory, selected, labels);
  if (labels && inventory.tier !== "L0" && map.domains.length === 0) {
    throw new Error("survey-merge labels must provide at least one domain for a non-L0 run");
  }
  const mapPath = path.join(workdir, "analysis", "discovery-map.json");
  writeJson(mapPath, map);
  const artifactsPath = `analysis/receipts/discovery-artifacts-pass-${requestedPass}.json`;
  const artifacts = discoveryArtifacts({ selected, labelsRelative, artifactsPath });
  writeJson(path.join(workdir, artifactsPath), artifacts);
  return {
    ok: true,
    pass: requestedPass,
    artifactsPath,
    missingUnitIds,
    retryUnitIds,
    selectedUnitIds: selected.map((record) => record.receipt.coverageUnit.id),
    invalidReceiptPaths: [...invalid.keys()].sort(),
    needsDomainLabels: inventory.tier !== "L0" && map.domains.length === 0 && !labels,
    domains: map.domains.length,
    flows: map.flows.length,
  };
}
