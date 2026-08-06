/**
 * wiki-plan - Discover, model, and plan only. The operator runs `ow gate plan` afterwards.
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 */

export const meta = {
  name: "wiki-plan",
  description: "Survey frozen sources and produce a fail-closed WikiRunSpec",
  phases: [{ title: "Discover" }, { title: "Model" }, { title: "Plan" }],
};

const runId = args?.runId;
const workdir = args?.workdir;
if (typeof runId !== "string" || !runId || typeof workdir !== "string" || !workdir) {
  return { stopped: "runId and absolute workdir arguments are required" };
}
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

// Leave capacity below Claude Code's default subagent concurrency for control work.
const MAX_CONCURRENT_SURVEYS = 4;

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
for (let offset = 0; offset < units.length; offset += MAX_CONCURRENT_SURVEYS) {
  const wave = units.slice(offset, offset + MAX_CONCURRENT_SURVEYS);
  const results = await parallel(
    wave.map((unit, index) => () => {
      const outPath = `${workdir}/analysis/receipts/survey/${safeId(unit.id)}.json`;
      return agent(
        [
          `Surveyor. workdir=${workdir}; read ${skillRoot}/references/research.md in full.`,
          `Also read ${skillRoot}/references/business-discovery.md for business extraction order.`,
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
      path: result?.path ?? `${workdir}/analysis/receipts/survey/${safeId(unit.id)}.json`,
      digest: result?.digest ?? null,
      summary: result?.summary ?? "survey failed or returned no envelope",
    });
  }
}

const discovery = await agent(
  [
    `Reducer. Read ${skillRoot}/references/research.md and ${skillRoot}/references/business-discovery.md.`,
    `JIT-read only these receipt paths: ${JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path })))}.`,
    `Write ${workdir}/analysis/discovery-map.json with domains, flows, concepts, openQuestions and the complete coverageUnits from inventory.`,
    `Domains need id/title/summary; flows need id/title/trigger/outcome/steps and evidenceIds or evidence[].`,
    `Failed ledger ids must remain visible. Return only the envelope.`,
  ].join("\n"),
  { label: "reduce-discovery-map", schema: ENVELOPE },
);

phase("Model");
const projectModel = await agent(
  [
    `Project model reducer. Read ${skillRoot}/references/project-model.md and ${skillRoot}/references/business-discovery.md in full.`,
    `Read ${discovery?.path ?? `${workdir}/analysis/discovery-map.json`} and inventory; JIT-read supporting survey receipts by path only.`,
    `Ledger: ${JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path })))}.`,
    `Write complete ${workdir}/analysis/project-model.json with productPurpose, actors, domains, capabilities, entities, rules, flows, modules, dataModels, mappings, conflicts, gaps, and openQuestions.`,
    `Flows must include trigger, outcome, ordered steps, branches/failures, state changes, side effects, participatingKnowledgeIds, and evidenceIds when evidence exists; otherwise record structured gaps.`,
    `Do not paste the full model into the envelope. Return only {status,path,summary,digest}.`,
  ].join("\n"),
  { label: "reduce-project-model", schema: ENVELOPE },
);

phase("Plan");
const spec = await agent(
  [
    `Planner. Read ${skillRoot}/references/plan.md in full. workdir=${workdir}.`,
    `Read inventory, ${projectModel?.path ?? `${workdir}/analysis/project-model.json`}, and ${discovery?.path ?? `${workdir}/analysis/discovery-map.json`}.`,
    `Use the Project Knowledge Model as the main semantic input; JIT-read supporting receipts by path only.`,
    `Ledger: ${JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path })))}.`,
    `Write complete, source-grounded ${workdir}/analysis/spec.json. Every page needs path, type, title, question, critical, audiences, requiredSections, knowledgeIds, evidenceIds, and coverageUnitIds.`,
    `Bind every coverageUnitId or add structured cancellation with coverageUnitId, cancelled:true, reason.`,
    `Do not write candidate pages. Return only {status,path,summary,digest}.`,
  ].join("\n"),
  { label: "plan-spec", schema: ENVELOPE },
);

log(`plan finished for ${runId}; operator must run ow gate plan before /wiki-write-review`);
return {
  runId,
  workdir,
  ledger,
  discovery,
  projectModel,
  spec,
  next: `ow gate plan --run ${runId}`,
};
