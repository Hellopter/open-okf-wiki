/**
 * wiki-plan - Discover and plan, then auto-run `ow gate plan` unless approvePlan.
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 *
 * Args are optional. Resolve order: args → .wiki-agent/current.json → next-action → newest run.
 */

export const meta = {
  name: "wiki-plan",
  description: "Survey frozen sources, produce Spec, and auto-run the plan gate unless human approval is required",
  phases: [{ title: "Resolve" }, { title: "Discover" }, { title: "Plan" }, { title: "Gate" }],
};

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

const RESOLVE = {
  type: "object",
  properties: {
    runId: { type: "string" },
    workdir: { type: "string" },
    workspaceRoot: { type: "string" },
    approvePlan: { type: "boolean" },
    source: { type: "string" },
  },
  required: ["runId", "workdir", "workspaceRoot"],
};

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

function languageDirective(wikiLanguage) {
  if (wikiLanguage === "zh") {
    return [
      "wikiLanguage=zh (Simplified Chinese).",
      "All human-readable prose in receipts, Discovery Map labels/titles/purpose text, Spec titles/questions,",
      "and later candidate pages MUST be Simplified Chinese.",
      "Keep source identifiers, file paths, package/module names, APIs, and code tokens untranslated.",
    ].join(" ");
  }
  return [
    "wikiLanguage=en.",
    "All human-readable prose in receipts, Discovery Map labels/titles/purpose text, Spec titles/questions,",
    "and later candidate pages MUST be English.",
    "Keep source identifiers, file paths, package/module names, APIs, and code tokens untranslated.",
  ].join(" ");
}

function multiSourceDirective(sourceCount, tier) {
  if (!(sourceCount >= 2 || tier === "L3")) return "";
  return [
    "MULTI-SOURCE DEEP ANALYSIS REQUIRED.",
    "Do not collapse repositories into a thin overview.",
    "For every source: identify purpose, entry points, public surfaces, key modules, and outbound/inbound contracts with other sources.",
    "Discovery Map must include non-empty domains, at least one crossSource:true flow (or a later structured cancellation with reason),",
    "and evidence that spans multiple sources.",
    "Spec must plan overview + repository/surface map + architecture and/or per-source module pages + at least one critical cross-source flow page,",
    "with enough critical pages that each source is substantively covered (not only listed).",
  ].join(" ");
}

const MAX_CONCURRENT_SURVEYS = 8;

phase("Resolve");
const resolved = await agent(
  [
    "Resolve the active wiki run for this workspace.",
    `Prefer explicit args when present: ${JSON.stringify({ runId: args?.runId ?? null, workdir: args?.workdir ?? null })}.`,
    "Else read .wiki-agent/current.json, then .wiki-agent/next-action.json.",
    "Else pick the newest run under .wiki-agent/runs/*/meta.json whose workdir still exists.",
    "workdir must be absolute. workspaceRoot is the workspace directory that contains .wiki-agent/.",
    "approvePlan is true only when current.json/next-action.json sets approvePlan true.",
    "Return {runId,workdir,workspaceRoot,approvePlan,source}. Fail closed if none found.",
  ].join("\n"),
  { label: "resolve-active-run", schema: RESOLVE },
);

const runId = resolved?.runId;
const workdir = resolved?.workdir;
const workspaceRoot = resolved?.workspaceRoot;
if (typeof runId !== "string" || !runId || typeof workdir !== "string" || !workdir || typeof workspaceRoot !== "string" || !workspaceRoot) {
  return { stopped: "no active run; invoke /wiki (entry skill) or host: ow run" };
}
const approvePlan = resolved?.approvePlan === true;
const skillRoot = `${workdir}/skill`;

phase("Discover");
const inventory = await agent(
  [
    `Read ${workdir}/inputs/inventory.json and ${workdir}/inputs/run-policy.json.`,
    `Return required coverageUnits first, plus policy fields.`,
    `Return {units:[{id,kind,sourceId,path,label}],tier,sourceCount,wikiLanguage,focus}; no file bodies.`,
  ].join("\n"),
  {
    label: "load-inventory",
    schema: {
      type: "object",
      properties: {
        units: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        tier: { type: "string" },
        sourceCount: { type: "number" },
        wikiLanguage: { type: "string" },
        focus: { type: ["string", "null"] },
      },
      required: ["units"],
    },
  },
);
const units = inventory?.units?.length ? inventory.units : [{ id: "source:default", kind: "source" }];
const wikiLanguage = inventory?.wikiLanguage === "zh" ? "zh" : "en";
const tier = typeof inventory?.tier === "string" ? inventory.tier : "L0";
const sourceCount = typeof inventory?.sourceCount === "number" ? inventory.sourceCount : units.length;
const langRule = languageDirective(wikiLanguage);
const multiRule = multiSourceDirective(sourceCount, tier);
const focusRule =
  typeof inventory?.focus === "string" && inventory.focus.trim()
    ? `Operator focus (do not ignore): ${inventory.focus.trim()}`
    : "";

const ledger = [];
for (let offset = 0; offset < units.length; offset += MAX_CONCURRENT_SURVEYS) {
  const wave = units.slice(offset, offset + MAX_CONCURRENT_SURVEYS);
  const results = await parallel(
    wave.map((unit, index) => () => {
      const outPath = `${workdir}/analysis/receipts/survey/${safeId(unit.id)}.json`;
      return agent(
        [
          `Surveyor. workdir=${workdir}; read ${skillRoot}/references/research.md in full.`,
          `Also read ${workdir}/inputs/run-policy.json for wikiLanguage/focus/tier.`,
          langRule,
          multiRule,
          focusRule,
          `Survey this coverage unit deeply: ${JSON.stringify(unit)}. Read frozen sources only under ${workdir}/sources/.`,
          `Prefer manifests, entry points, public APIs, runtime paths, and cross-source contracts over marketing text.`,
          `Write full findings, source-relative evidence with real line ranges, integration points, and open questions to ${outPath}.`,
          `Return only {status,path,summary,digest}; summary <= 8 bullets in ${wikiLanguage === "zh" ? "Simplified Chinese" : "English"}.`,
        ]
          .filter(Boolean)
          .join("\n"),
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
    `Reducer. Read ${skillRoot}/references/research.md.`,
    `Read ${workdir}/inputs/inventory.json and ${workdir}/inputs/run-policy.json.`,
    langRule,
    multiRule,
    `JIT-read only these receipt paths: ${JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path })))}.`,
    `Write ${workdir}/analysis/discovery-map.json with domains, flows, concepts, openQuestions and the complete coverageUnits from inventory.`,
    `Human-readable labels/purpose/openQuestions must follow wikiLanguage=${wikiLanguage}.`,
    `Failed ledger ids must remain visible. Return only the envelope.`,
  ]
    .filter(Boolean)
    .join("\n"),
  { label: "reduce-discovery-map", schema: ENVELOPE },
);

phase("Plan");
const spec = await agent(
  [
    `Planner. Read ${skillRoot}/references/plan.md in full. workdir=${workdir}.`,
    `Read ${workdir}/inputs/inventory.json, ${workdir}/inputs/run-policy.json, and ${discovery?.path ?? `${workdir}/analysis/discovery-map.json`}; JIT-read supporting receipts by path.`,
    langRule,
    multiRule,
    focusRule,
    `Ledger: ${JSON.stringify(ledger.map(({ id, status, path }) => ({ id, status, path })))}.`,
    `Write complete, source-grounded ${workdir}/analysis/spec.json.`,
    `Set top-level wikiLanguage to "${wikiLanguage}" and use that language for every page title and question.`,
    `Bind every coverageUnitId or add structured cancellation with coverageUnitId, cancelled:true, reason.`,
    sourceCount >= 2
      ? "For multi-source runs: include critical overview with repository/surface map; plan architecture and/or per-source module pages; plan at least one critical cross-source Flow page (or set crossSourceFlowCancellation with cancelled:true and reason)."
      : "",
    `Do not write candidate pages. Return only {status,path,summary,digest}.`,
  ]
    .filter(Boolean)
    .join("\n"),
  { label: "plan-spec", schema: ENVELOPE },
);

if (approvePlan) {
  log(`plan finished for ${runId}; approvePlan=true — operator must run: ow approve plan --run ${runId}`);
  return {
    runId,
    workdir,
    workspaceRoot,
    wikiLanguage,
    tier,
    sourceCount,
    ledger,
    discovery,
    spec,
    approvePlan: true,
    next: `ow approve plan --run ${runId}`,
  };
}

phase("Gate");
const gate = await agent(
  [
    `Plan gate. Read ${workdir}/inputs/run-policy.json for hostCli.`,
    `Run exactly: <hostCli.node> <hostCli.script> gate plan --run ${runId} --workspace <hostCli.workspaceRoot>,`,
    `substituting hostCli values (workspaceRoot should be ${workspaceRoot}).`,
    `This writes inputs/gate-plan.ok.json on success and updates .wiki-agent/current.json + next-action.json.`,
    `Write the command JSON output to ${workdir}/analysis/receipts/gate-plan.json.`,
    `Return ok only when the host command exits successfully; return only the envelope.`,
  ].join("\n"),
  { label: "auto-gate-plan", schema: ENVELOPE },
);

if (gate?.status !== "ok") {
  log(`plan gate failed for ${runId}`);
  return {
    runId,
    workdir,
    workspaceRoot,
    wikiLanguage,
    tier,
    sourceCount,
    ledger,
    discovery,
    spec,
    gate,
    stopped: "plan gate failed; fix Spec/Discovery Map then retry /wiki-plan or ow retry --from plan",
  };
}

log(`plan+gate finished for ${runId}; next /wiki-write-review (no args)`);
return {
  runId,
  workdir,
  workspaceRoot,
  wikiLanguage,
  tier,
  sourceCount,
  ledger,
  discovery,
  spec,
  gate,
  next: "/wiki-write-review",
};
