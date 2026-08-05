/**
 * wiki-write-review - requires a digest-valid plan receipt before any write.
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 */

export const meta = {
  name: "wiki-write-review",
  description: "Write, adversarially review, repair, validate, and seal a candidate Wiki",
  phases: [{ title: "Preflight" }, { title: "Write" }, { title: "Review" }, { title: "Repair" }, { title: "Validate" }],
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

function languageDirective(wikiLanguage) {
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
  return { runId, workdir, preflight, stopped: "valid plan gate receipt required" };
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
const wikiLanguage = policy?.wikiLanguage === "zh" ? "zh" : "en";
const sourceCount = typeof policy?.sourceCount === "number" ? policy.sourceCount : 1;
const langRule = languageDirective(wikiLanguage);
const multiRule =
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
    langRule,
    multiRule,
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
if (writer?.status !== "ok") return { runId, workdir, preflight, writer, stopped: "writer failed" };

let finalReview = null;
for (let round = 1; round <= 2; round++) {
  phase("Review");
  const lensNames = ["citation-grounding", "coverage-completeness", "information-architecture"];
  const lenses = await parallel(
    lensNames.map((lens) => () =>
      agent(
        [
          `Reviewer (${lens}). Read ${skillRoot}/references/review.md in full.`,
          `Inspect ${workdir}/candidate/ against ${workdir}/analysis/spec.json, ${workdir}/inputs/run-policy.json, and frozen sources.`,
          langRule,
          multiRule,
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
      langRule,
      multiRule,
      `Repair only blocking and major defects in ${workdir}/candidate/; do not change ${workdir}/analysis/spec.json or add pages outside the Spec.`,
      `Preserve valid local Source Citations. Deepen multi-source pages when defects require it. Return only the envelope.`,
    ]
      .filter(Boolean)
      .join("\n"),
    { label: `repair:${round}`, schema: ENVELOPE },
  );
  if (repair?.status !== "ok") return { runId, workdir, preflight, writer, finalReview, repair, stopped: "repair failed" };
}
if (finalReview?.status !== "ok" || !finalReview?.clean) {
  return { runId, workdir, preflight, writer, finalReview, stopped: "candidate has unresolved defects" };
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
log(`write/review finished for ${runId}: ${validation?.status ?? "unknown"}`);
return { runId, workdir, wikiLanguage, sourceCount, preflight, writer, review: finalReview, validation };
