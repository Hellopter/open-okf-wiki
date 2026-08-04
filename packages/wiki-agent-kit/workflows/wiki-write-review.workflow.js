/**
 * wiki-write-review - requires a digest-valid plan receipt before any write.
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 */

export const meta = {
  name: "wiki-write-review",
  description: "Write, adversarially review, repair, validate, and seal a candidate Wiki",
  phases: [{ title: "Preflight" }, { title: "Write" }, { title: "Review" }, { title: "Repair" }, { title: "Validate" }],
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

phase("Preflight");
const preflight = await agent(
  [
    `Preflight. workdir=${workdir}. Read inputs/run-policy.json and inputs/gate-plan.ok.json.`,
    `Run the host CLI gate check for run ${runId} using hostCli from run-policy.`,
    `Fail if the gate receipt is stale, missing, invalid, or analysis/candidate.manifest.json exists. Do not write candidate files.`,
    `Return only {status,path,summary}.`,
  ].join("\n"),
  { label: "verify-plan-gate", schema: ENVELOPE },
);
if (preflight?.status !== "ok") {
  return { runId, workdir, preflight, stopped: "valid plan gate receipt required" };
}

phase("Write");
const writer = await agent(
  [
    `Writer. Read ${skillRoot}/references/generate.md in full.`,
    `Read analysis/spec.json; it is the sole candidate page-set authority. Write only under ${workdir}/candidate/.`,
    `For every source claim generate a local relative citation such as [Source: src/A.java L1-L2](../sources/api/src/A.java#L1-L2).`,
    `For nested candidate pages calculate the relative path to sources/<sourceId>/ correctly. Never use repo:, remote URLs, file://, or vscode://.`,
    `Do not write index.md or log.md. Return only the envelope.`,
  ].join("\n"),
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
          `Inspect candidate/ against analysis/spec.json and frozen sources. Write full findings to analysis/receipts/review/${lens}-round-${round}.json.`,
          `Return only the envelope; do not edit candidate pages.`,
        ].join("\n"),
        { label: `review:${lens}:${round}`, schema: ENVELOPE },
      ),
    ),
  );
  finalReview = await agent(
    [
      `Review reducer. JIT-read the three review receipt paths for round ${round}.`,
      `Write ${workdir}/analysis/defects.json. clean is true only when defects is empty; blockingCount counts blocking defects.`,
      `Return {status,path,summary,clean,blockingCount}.`,
    ].join("\n"),
    { label: `reduce-defects:${round}`, schema: REVIEW },
  );
  if (finalReview?.status !== "ok" || finalReview.clean) break;
  if (round === 2) break;
  phase("Repair");
  const repair = await agent(
    [
      `Repairer. Read ${skillRoot}/references/generate.md and analysis/defects.json.`,
      `Repair only blocking and major defects in ${workdir}/candidate/; do not change analysis/spec.json or add pages outside the Spec.`,
      `Preserve valid local Source Citations. Return only the envelope.`,
    ].join("\n"),
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
    `Validator. Read inputs/run-policy.json for hostCli, then run its validate command for run ${runId}.`,
    `It regenerates indexes, validates local source links, and seals candidate on success. Write command output to analysis/validation.json.`,
    `Return ok only when the host command exits successfully; return only the envelope.`,
  ].join("\n"),
  { label: "validate-and-seal", schema: ENVELOPE },
);
log(`write/review finished for ${runId}: ${validation?.status ?? "unknown"}`);
return { runId, workdir, preflight, writer, review: finalReview, validation };
