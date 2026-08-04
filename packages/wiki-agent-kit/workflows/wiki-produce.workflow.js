/**
 * wiki-produce — inventory → discover → plan → (gate) → write → review
 *
 * Claude Dynamic Workflow. Globals: agent, parallel, pipeline, phase, log, args.
 * Host: `ow produce` → args { runId, workdir }.
 * After Plan: MUST run `ow gate plan --run <runId>` before Write is authoritative.
 * After Write/Review: `ow validate --run <runId>`.
 */

export const meta = {
  name: "wiki_produce",
  description:
    "Source-grounded OKF wiki: survey units, plan Spec, write pages, review (receipts + envelopes)",
  phases: [
    { title: "Discover" },
    { title: "Plan" },
    { title: "Write" },
    { title: "Review" },
  ],
};

const runId = (args && args.runId) || (args && args.run) || null;
const workdir = (args && args.workdir) || ".";
const skillRoot = `${workdir}/skill`;

const ENVELOPE = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    path: { type: "string" },
    summary: { type: "string" },
  },
  required: ["status", "path", "summary"],
};

const SPEC_ENV = {
  type: "object",
  properties: {
    status: { type: "string" },
    path: { type: "string" },
    summary: { type: "string" },
    pageCount: { type: "number" },
    criticalMissing: { type: "array", items: { type: "string" } },
  },
  required: ["status", "path", "summary"],
};

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

function receiptPrompt(role, unit, outPath, extra) {
  return [
    `${role}. runId=${runId || "?"} workdir=${workdir}`,
    `Method: ${skillRoot}/SKILL.md + references. Orchestrator: ${skillRoot}/references/orchestrator-context.md`,
    `Write FULL findings to ${outPath}. Return ONLY {status,path,summary} (summary ≤8 bullets).`,
    unit ? `Unit: ${JSON.stringify(unit)}` : "",
    extra || "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Discover ────────────────────────────────────────────────────────────────
phase("Discover");
log(`discover runId=${runId} workdir=${workdir}`);

const inventoryPick = await agent(
  [
    `Workdir ${workdir}: read inputs/inventory.json if present.`,
    `Return { units:[{id,kind,sourceId?,label?}], tier, sourceCount }.`,
    `units = coverageUnits (required first). If missing: [{id:"source:default",kind:"source"}].`,
    `Compact list only — no file bodies.`,
  ].join("\n"),
  {
    label: "load-inventory-units",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              sourceId: { type: "string" },
              label: { type: "string" },
            },
            required: ["id"],
          },
        },
        tier: { type: "string" },
        sourceCount: { type: "number" },
      },
      required: ["units"],
    },
  },
);

const units =
  Array.isArray(inventoryPick?.units) && inventoryPick.units.length
    ? inventoryPick.units
    : [{ id: "source:default", kind: "source" }];

// Fan-out surveys. INVARIANT: ledger preserves failed unit ids (never drop nulls).
const surveyResults = await parallel(
  units.map((unit, index) => () => {
    const outPath = `analysis/receipts/survey/${safeId(unit.id)}.json`;
    return agent(
      receiptPrompt(
        "Surveyor",
        unit,
        outPath,
        "Survey sources/ for this unit (entrypoints + implementation). Receipt: findings, evidencePaths with real lines, openQuestions.",
      ),
      { label: `survey:${index}:${safeId(unit.id)}`, schema: ENVELOPE },
    );
  }),
);

const ledger = units.map((unit, index) => {
  const r = surveyResults[index];
  const failed = r == null || r.status === "failed";
  return {
    id: String(unit.id),
    kind: unit.kind || null,
    status: failed ? "failed" : "complete",
    path: r?.path || `analysis/receipts/survey/${safeId(unit.id)}.json`,
    summary: r?.summary || (failed ? "survey failed or null" : ""),
  };
});
const failedIds = ledger.filter((e) => e.status === "failed").map((e) => e.id);
log(`ledger units=${ledger.length} failed=${failedIds.length}`);

const mapEnvelope = await agent(
  [
    `Merge survey receipts → analysis/discovery-map.json (update inputs/ copy if needed).`,
    `Read ${skillRoot}/references/research.md. Ledger paths only (JIT-read; do not invent):`,
    JSON.stringify(ledger),
    `domains[], flows[] (crossSource if multi-source), openQuestions[]; keep coverageUnits.`,
    `Failed ids stay visible — never silent drop. Return envelope path=analysis/discovery-map.json.`,
  ].join("\n"),
  { label: "reduce-discovery-map", schema: ENVELOPE },
);

// ── Plan ────────────────────────────────────────────────────────────────────
phase("Plan");
log("plan → analysis/spec.json; host must: ow gate plan --run <runId> before write");

const planEnvelope = await agent(
  [
    `Planner. Read ${skillRoot}/references/plan.md. workdir=${workdir}.`,
    `Inputs: inventory + ${mapEnvelope?.path || "analysis/discovery-map.json"}.`,
    `Ledger (bind/cancel/openQuestions; include failed):`,
    JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path }))),
    `Write COMPLETE analysis/spec.json: domains, pages (critical), coverageUnitIds,`,
    `sourceCoverage/surfaceCoverage cancellations+notes, openQuestions, changelog.`,
    `No wiki pages. No generated/verified/stale_after. Fail-closed on unbound required units.`,
    `Return {status, path:"analysis/spec.json", summary, pageCount, criticalMissing}.`,
  ].join("\n"),
  { label: "plan-spec", schema: SPEC_ENV },
);

// NOTE: Write is not authoritative until `ow gate plan --run <runId>` passes.

// ── Write ───────────────────────────────────────────────────────────────────
phase("Write");
log("write Spec-bound; require inputs/gate-plan.ok.json from ow gate plan");

const writeEnvelope = await agent(
  [
    `FIRST: read ${workdir}/inputs/gate-plan.ok.json. If missing or ok!==true, status=failed and DO NOT write wiki pages (host must run \`ow gate plan --run ${runId || "<runId>"}\` first).`,
    `Read ${skillRoot}/references/generate.md. Spec analysis/spec.json is sole page-set authority.`,
    `Templates ${skillRoot}/templates/ → wiki/. Frontmatter type/title/description only.`,
    `Citations repo:path#L1-L2 or repo:id/path#L1-L2; never invent lines; never sources/ prefix.`,
    `wikiLanguage en|zh prose only. No index.md/log.md concept pages. All critical paths must exist.`,
    `Return envelope {status, path, summary}.`,
  ].join("\n"),
  { label: "write-wiki", schema: ENVELOPE },
);

// ── Review ──────────────────────────────────────────────────────────────────
phase("Review");

const reviewEnvelope = await agent(
  [
    `Read ${skillRoot}/references/review.md. Verify wiki/ vs analysis/spec.json.`,
    `Write analysis/defects.json. Envelope {status, path:"analysis/defects.json", summary}.`,
    `Host next: ow validate --run ${runId || "<runId>"}.`,
  ].join("\n"),
  { label: "review-wiki", schema: ENVELOPE },
);

return {
  runId,
  workdir,
  ledger,
  failedIds,
  discoveryMap: mapEnvelope,
  plan: planEnvelope,
  write: writeEnvelope,
  review: reviewEnvelope,
  next: {
    gate: runId ? `ow gate plan --run ${runId}` : "ow gate plan --run <runId>",
    validate: runId ? `ow validate --run ${runId}` : "ow validate --run <runId>",
    note: "Gate plan before treating write as authoritative.",
  },
};
