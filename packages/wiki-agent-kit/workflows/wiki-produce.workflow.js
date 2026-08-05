/**
 * wiki-produce - real multi-phase E2E: plan → auto gate → write → review → validate.
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 *
 * Prefer no args. Active run from .wiki-agent/current.json (set by /wiki entry or ow run).
 * If approvePlan on the pointer, stop after Spec for host `ow approve plan`.
 * If already write-ready, skip Discover/Plan/Gate and start at Preflight.
 */

export const meta = {
  name: "wiki-produce",
  description: "End-to-end wiki production with real multi-phase topology and host gates",
  phases: [
    { title: "Resolve" },
    { title: "Discover" },
    { title: "Plan" },
    { title: "Gate" },
    { title: "Preflight" },
    { title: "Write" },
    { title: "Review" },
    { title: "Repair" },
    { title: "Validate" },
  ],
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
const REVIEW = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    path: { type: "string" },
    summary: { type: "string", maxLength: 6000 },
    clean: { type: "boolean" },
    blockingCount: { type: "number" },
  },
  required: ["status", "path", "summary", "clean", "blockingCount"],
};
const RESOLVE = {
  type: "object",
  properties: {
    runId: { type: "string" },
    workdir: { type: "string" },
    workspaceRoot: { type: "string" },
    approvePlan: { type: "boolean" },
    phase: { type: "string" },
    command: { type: "string" },
    writeReady: { type: "boolean" },
    source: { type: "string" },
  },
  required: ["runId", "workdir", "workspaceRoot"],
};

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

function languageDirectivePlan(wikiLanguage) {
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

function languageDirectiveWrite(wikiLanguage) {
  if (wikiLanguage === "zh") {
    return [
      "wikiLanguage=zh (Simplified Chinese).",
      "Every candidate page title, description, headings, and body prose MUST be Simplified Chinese.",
      "Keep identifiers, source paths, package/module names, APIs, and code tokens untranslated.",
      "A mostly-English page when wikiLanguage=zh is a major defect.",
    ].join(" ");
  }
  return [
    "wikiLanguage=en.",
    "Every candidate page title, description, headings, and body prose MUST be English.",
    "Keep identifiers, source paths, package/module names, APIs, and code tokens untranslated.",
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
    "Resolve the active wiki run for end-to-end production.",
    `Prefer explicit args when present: ${JSON.stringify({ runId: args?.runId ?? null, workdir: args?.workdir ?? null })}.`,
    "Else read .wiki-agent/current.json and .wiki-agent/next-action.json.",
    "Else pick the newest frozen/planned/write-ready run under .wiki-agent/runs/*/meta.json.",
    "workdir must be absolute. workspaceRoot contains .wiki-agent/.",
    "writeReady=true when inputs/gate-plan.ok.json exists and candidate is not sealed (no analysis/candidate.manifest.json).",
    "approvePlan from current/next-action. Return {runId,workdir,workspaceRoot,approvePlan,phase,command,writeReady,source}.",
    "Fail closed if no run — human should invoke /wiki (entry skill) first.",
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
const writeReady = resolved?.writeReady === true;
const skillRoot = `${workdir}/skill`;

let ledger = [];
let discovery = null;
let spec = null;
let gate = null;
let wikiLanguage = "en";
let tier = "L0";
let sourceCount = 1;

if (!writeReady) {
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
  wikiLanguage = inventory?.wikiLanguage === "zh" ? "zh" : "en";
  tier = typeof inventory?.tier === "string" ? inventory.tier : "L0";
  sourceCount = typeof inventory?.sourceCount === "number" ? inventory.sourceCount : units.length;
  const langRule = languageDirectivePlan(wikiLanguage);
  const multiRule = multiSourceDirective(sourceCount, tier);
  const focusRule =
    typeof inventory?.focus === "string" && inventory.focus.trim()
      ? `Operator focus (do not ignore): ${inventory.focus.trim()}`
      : "";

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

  discovery = await agent(
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
  spec = await agent(
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
    log(`produce plan finished for ${runId}; approvePlan=true — host: ow approve plan`);
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
      stopped: "waiting for host plan approval",
    };
  }

  phase("Gate");
  gate = await agent(
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
      stopped: "plan gate failed; fix Spec then /wiki or host: ow retry --from plan",
    };
  }
}

// ---- Write path (same topology as wiki-write-review) ----
phase("Preflight");
const preflight = await agent(
  [
    `Preflight. Read ${workdir}/inputs/run-policy.json and ${workdir}/inputs/gate-plan.ok.json.`,
    `Also read ${workdir}/inputs/inventory.json for wikiLanguage, tier, and sourceCount.`,
    `Run exactly: <hostCli.node> <hostCli.script> gate check --run ${runId} --workspace <hostCli.workspaceRoot>, substituting values from run-policy.`,
    `Fail if the command fails, the receipt is stale or missing, or ${workdir}/analysis/candidate.manifest.json exists. Do not write candidate files.`,
    `Write a concise preflight receipt to ${workdir}/analysis/receipts/preflight.json including wikiLanguage, tier, and sourceCount.`,
    `Return only {status,path,summary}. summary must mention wikiLanguage.`,
  ].join("\n"),
  { label: "verify-plan-gate", schema: ENVELOPE },
);
if (preflight?.status !== "ok") {
  return { runId, workdir, workspaceRoot, preflight, stopped: "valid plan gate receipt required" };
}

const policy = await agent(
  [
    `Read ${workdir}/inputs/run-policy.json, ${workdir}/inputs/inventory.json, and ${workdir}/analysis/spec.json.`,
    `Return {wikiLanguage,tier,sourceCount,pageCount,criticalPageCount,hasCrossSourceFlowPage} only; no file bodies.`,
  ].join("\n"),
  {
    label: "load-write-policy",
    schema: {
      type: "object",
      properties: {
        wikiLanguage: { type: "string" },
        tier: { type: "string" },
        sourceCount: { type: "number" },
        pageCount: { type: "number" },
        criticalPageCount: { type: "number" },
        hasCrossSourceFlowPage: { type: "boolean" },
      },
      required: ["wikiLanguage"],
    },
  },
);
wikiLanguage = policy?.wikiLanguage === "zh" ? "zh" : "en";
sourceCount = typeof policy?.sourceCount === "number" ? policy.sourceCount : sourceCount;
const writeLangRule = languageDirectiveWrite(wikiLanguage);
const writeMultiRule =
  sourceCount >= 2
    ? [
        "MULTI-SOURCE DEEP ANALYSIS REQUIRED in candidate pages.",
        "Do not produce a thin multi-repo wiki.",
        "Overview must include a repository/surface map naming every source.",
        "Each source needs substantive coverage via Architecture and/or Module pages with real Source Citations.",
        "At least one Flow page must narrate a cross-source journey with stage-level citations into each participating sources/<id>/ tree,",
        "unless the Spec records crossSourceFlowCancellation.",
        "Explain integration contracts, ownership boundaries, and failure behavior with evidence — not slogans.",
      ].join(" ")
    : "";

phase("Write");
const writer = await agent(
  [
    `Writer. Read ${skillRoot}/references/generate.md in full and adapt templates under ${skillRoot}/templates/ as needed.`,
    `Read ${workdir}/inputs/run-policy.json and ${workdir}/analysis/spec.json; Spec is the sole candidate page-set authority.`,
    writeLangRule,
    writeMultiRule,
    `Write only under ${workdir}/candidate/. Re-open evidence spans inside ${workdir}/sources/<id>/ as needed; never invent line ranges.`,
    `For every source claim generate a local relative citation such as [Source: src/A.java L1-L2](../sources/api/src/A.java#L1-L2).`,
    `For nested candidate pages calculate the relative path to sources/<sourceId>/ correctly. Never use repo:, remote URLs, file://, or vscode://.`,
    `Each page must answer its Spec question with concrete, evidence-backed depth — not a README restatement.`,
    `Do not write index.md or log.md. Return only the envelope.`,
  ]
    .filter(Boolean)
    .join("\n"),
  { label: "write-candidate", schema: ENVELOPE },
);
if (writer?.status !== "ok") {
  return { runId, workdir, workspaceRoot, preflight, writer, stopped: "writer failed" };
}

let finalReview = null;
for (let round = 1; round <= 2; round++) {
  phase("Review");
  const lensNames = ["citation-grounding", "coverage-completeness", "information-architecture"];
  await parallel(
    lensNames.map((lens) => () =>
      agent(
        [
          `Reviewer (${lens}). Read ${skillRoot}/references/review.md in full.`,
          `Inspect ${workdir}/candidate/ against ${workdir}/analysis/spec.json, ${workdir}/inputs/run-policy.json, and frozen sources.`,
          writeLangRule,
          writeMultiRule,
          `Flag language mismatches against wikiLanguage=${wikiLanguage} as major (or blocking when the whole candidate is wrong language).`,
          sourceCount >= 2
            ? "Flag thin multi-source coverage as major/blocking: missing repo map, missing cross-source flow depth, or sources reduced to slogans without evidence."
            : "",
          `Write full findings to ${workdir}/analysis/receipts/review/${lens}-round-${round}.json.`,
          `Return only the envelope; do not edit candidate pages.`,
        ]
          .filter(Boolean)
          .join("\n"),
        { label: `review:${lens}:${round}`, schema: ENVELOPE },
      ),
    ),
  );
  finalReview = await agent(
    [
      `Review reducer. JIT-read the three review receipt paths in ${workdir}/analysis/receipts/review/ for round ${round}.`,
      `Write ${workdir}/analysis/defects.json. clean is true only when defects is empty; blockingCount counts blocking defects.`,
      `Include language_mismatch and thin_multi_source findings when present.`,
      `Return {status,path,summary,clean,blockingCount}.`,
    ].join("\n"),
    { label: `reduce-defects:${round}`, schema: REVIEW },
  );
  if (finalReview?.status !== "ok" || finalReview.clean) break;
  if (round === 2) break;
  phase("Repair");
  const repair = await agent(
    [
      `Repairer. Read ${skillRoot}/references/generate.md and ${workdir}/analysis/defects.json.`,
      `Also read ${workdir}/inputs/run-policy.json and ${workdir}/analysis/spec.json.`,
      writeLangRule,
      writeMultiRule,
      `Repair only blocking and major defects in ${workdir}/candidate/; do not change ${workdir}/analysis/spec.json or add pages outside the Spec.`,
      `Preserve valid local Source Citations. Deepen multi-source pages when defects require it. Return only the envelope.`,
    ]
      .filter(Boolean)
      .join("\n"),
    { label: `repair:${round}`, schema: ENVELOPE },
  );
  if (repair?.status !== "ok") {
    return { runId, workdir, workspaceRoot, preflight, writer, finalReview, repair, stopped: "repair failed" };
  }
}
if (finalReview?.status !== "ok" || !finalReview?.clean) {
  return { runId, workdir, workspaceRoot, preflight, writer, finalReview, stopped: "candidate has unresolved defects" };
}

phase("Validate");
const validation = await agent(
  [
    `Validator. Read ${workdir}/inputs/run-policy.json for hostCli, then run exactly: <hostCli.node> <hostCli.script> validate --run ${runId} --workspace <hostCli.workspaceRoot>.`,
    `It regenerates indexes, validates local source links, and seals the candidate only after rechecking the plan gate. Write command output to ${workdir}/analysis/validation.json.`,
    `Return ok only when the host command exits successfully; return only the envelope.`,
  ].join("\n"),
  { label: "validate-and-seal", schema: ENVELOPE },
);

log(`wiki-produce finished for ${runId}: ${validation?.status ?? "unknown"}`);
return {
  runId,
  workdir,
  workspaceRoot,
  wikiLanguage,
  sourceCount,
  ledger,
  discovery,
  spec,
  gate,
  preflight,
  writer,
  review: finalReview,
  validation,
  next: "done",
};
