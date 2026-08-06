import fs from "node:fs";
import path from "node:path";

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function receiptPathFor(unit) {
  return `analysis/receipts/survey/${unit.id.replace(/[^A-Za-z0-9._:-]+/g, "-")}-pass-1.json`;
}

/** Write contract-valid receipts plus frozen evidence for a test inventory. */
export function writeSurveyReceipts(workdir, inventory, { statusByUnit = {}, evidencePathByUnit = {} } = {}) {
  const artifacts = [];
  const units = inventory.coverageUnits ?? [];
  for (const unit of units) {
    const status = statusByUnit[unit.id]?.status ?? "ok";
    const retryable = statusByUnit[unit.id]?.retryable ?? false;
    const sourceRelative = evidencePathByUnit[unit.id] ?? (unit.kind === "surface"
      ? `sources/${unit.sourceId}/${unit.path}/evidence.js`
      : `sources/${unit.sourceId}/evidence.js`);
    const evidenceFile = path.join(workdir, sourceRelative);
    if (!fs.existsSync(evidenceFile)) {
      fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
      fs.writeFileSync(evidenceFile, "export const evidence = true;\n", "utf8");
    }
    const receipt = {
      coverageUnit: {
        id: unit.id,
        kind: unit.kind,
        sourceId: unit.sourceId,
        path: unit.path,
        label: unit.label,
      },
      status,
      purpose: `${unit.id} purpose`,
      summary: `${unit.id} summary`,
      entryPoints: [],
      modules: [],
      runtimeFlows: [],
      contracts: [],
      evidence: status === "ok" ? [{ id: "evidence", path: sourceRelative, startLine: 1, endLine: 1, summary: "source line" }] : [],
      plannerHints: {
        domains: unit.kind === "source" ? [{ id: `domain:${unit.sourceId}`, summary: `${unit.sourceId} domain` }] : [],
        flows: [],
      },
      openQuestions: [],
      ...(unit.kind === "source" ? {
        relatedCoverageUnitIds: units
          .filter((candidate) => candidate.kind === "surface" && candidate.sourceId === unit.sourceId)
          .map((candidate) => candidate.id),
      } : {}),
      ...(status === "ok" ? {} : {
        insufficiency: {
          code: retryable ? "timeout" : "snapshot_missing",
          retryable,
          reason: "test insufficiency",
        },
      }),
    };
    const relative = receiptPathFor(unit);
    writeJson(path.join(workdir, relative), receipt);
    artifacts.push({ id: `survey:${unit.id}`, type: "survey-receipt", path: relative, coverageUnitIds: [unit.id] });
  }
  return artifacts;
}
