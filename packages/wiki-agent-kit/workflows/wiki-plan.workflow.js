/**
 * wiki-plan - Discover and plan only. Run `ow gate plan` after it finishes.
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 */

export const meta = {
  name: "wiki-plan",
  description: "Survey frozen sources and produce a fail-closed WikiRunSpec",
  phases: [{ title: "Discover" }, { title: "Plan" }],
};

const runId = args?.runId ?? args?.run ?? null;
const workdir = args?.workdir ?? ".";
const skillRoot = `${workdir}/skill`;
const ENVELOPE = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    path: { type: "string" },
    summary: { type: "string", maxLength: 6000 },
    digest: { type: "string" },
  },
  required: ["status", "path", "summary"],
};

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

phase("Discover");
const inventory = await agent(
  [
    `Read ${workdir}/inputs/inventory.json. Return required coverageUnits first.`,
    `Return {units:[{id,kind,sourceId,path,label}],tier,sourceCount}; no file bodies.`,
  ].join("\n"),
  {
    label: "load-inventory",
    schema: {
      type: "object",
      properties: {
        units: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        tier: { type: "string" },
        sourceCount: { type: "number" },
      },
      required: ["units"],
    },
  },
);
const units = inventory?.units?.length ? inventory.units : [{ id: "source:default", kind: "source" }];
const ledger = [];
for (let offset = 0; offset < units.length; offset += 4) {
  const wave = units.slice(offset, offset + 4);
  const results = await parallel(
    wave.map((unit, index) => () => {
      const outPath = `analysis/receipts/survey/${safeId(unit.id)}.json`;
      return agent(
        [
          `Surveyor. workdir=${workdir}; read ${skillRoot}/references/research.md in full.`,
          `Survey this coverage unit: ${JSON.stringify(unit)}. Read frozen sources only.`,
          `Write full findings, source-relative evidence and open questions to ${outPath}.`,
          `Return only {status,path,summary,digest}; summary <= 8 bullets.`,
        ].join("\n"),
        { label: `survey:${offset + index}:${safeId(unit.id)}`, schema: ENVELOPE },
      );
    }),
  );
  for (let index = 0; index < wave.length; index++) {
    const unit = wave[index];
    const result = results[index];
    ledger.push({
      id: String(unit.id),
      status: result?.status === "ok" ? "complete" : "failed",
      path: result?.path ?? `analysis/receipts/survey/${safeId(unit.id)}.json`,
      digest: result?.digest ?? null,
      summary: result?.summary ?? "survey failed or returned no envelope",
    });
  }
}

const discovery = await agent(
  [
    `Reducer. Read ${skillRoot}/references/research.md.`,
    `JIT-read only these receipt paths: ${JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path })))}.`,
    `Write ${workdir}/analysis/discovery-map.json with domains, flows, concepts, openQuestions and the complete coverageUnits from inventory.`,
    `Failed ledger ids must remain visible. Return only the envelope.`,
  ].join("\n"),
  { label: "reduce-discovery-map", schema: ENVELOPE },
);

phase("Plan");
const spec = await agent(
  [
    `Planner. Read ${skillRoot}/references/plan.md in full. workdir=${workdir}.`,
    `Read inventory and ${discovery?.path ?? "analysis/discovery-map.json"}; JIT-read supporting receipts by path.`,
    `Ledger: ${JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path })))}.`,
    `Write complete, source-grounded ${workdir}/analysis/spec.json. Bind every coverageUnitId or add structured cancellation with coverageUnitId, cancelled:true, reason.`,
    `Do not write candidate pages. Return only {status,path,summary,digest}.`,
  ].join("\n"),
  { label: "plan-spec", schema: ENVELOPE },
);

log(`plan finished for ${runId}; operator must run ow gate plan before /wiki-write-review`);
return { runId, workdir, ledger, discovery, spec, next: `ow gate plan --run ${runId}` };
