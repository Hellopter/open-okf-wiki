/**
 * Static Pi Dynamic Workflow script. The core remains the authority for every
 * state transition; agents only create run-local evidence and candidate pages.
 */
export const WIKI_WORKFLOW_SCRIPT = String.raw`export const meta = {
  name: "wiki",
  description: "Produce a source-grounded Wiki through checkpointed survey, planning, writing, review, repair, and sealing",
  phases: [
    { title: "Bootstrap", detail: "prepare or resume an authoritative run" },
    { title: "Survey", detail: "cover frozen source units and merge receipts" },
    { title: "Plan", detail: "define page ownership and checkpoint the plan" },
    { title: "Gate", detail: "wait for explicit plan approval" },
    { title: "Write", detail: "produce owned candidate pages" },
    { title: "Verify", detail: "independently refute unsupported claims" },
    { title: "Repair", detail: "repair reported defects without changing ownership" },
    { title: "Validate", detail: "mechanically validate and seal" },
  ],
};

const ENVELOPE = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed", "blocked"] },
    summary: { type: "string", maxLength: 3000 },
  },
};

const BOOTSTRAP = {
  type: "object",
  additionalProperties: false,
  required: ["status", "runId", "workdir", "workspaceRoot", "mode", "startAt"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    runId: { type: "string", minLength: 1 },
    workdir: { type: "string", minLength: 1 },
    workspaceRoot: { type: "string", minLength: 1 },
    mode: { type: "string" },
    startAt: { type: "string" },
    inputCheckpointDigest: { type: ["string", "null"] },
    summary: { type: "string", maxLength: 6000 },
  },
};

const INVENTORY = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "units", "limits"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string", maxLength: 3000 },
    units: { type: "array", items: { type: "object" } },
    limits: { type: "object" },
  },
};

const SURVEY_MERGE = {
  type: "object",
  additionalProperties: false,
  required: ["status", "pass", "artifactsPath", "missingUnitIds", "retryUnitIds", "needsDomainLabels"],
  properties: {
    ok: { type: "boolean" },
    status: { type: "string", enum: ["ok", "failed"] },
    pass: { type: "integer", minimum: 1 },
    artifactsPath: { type: "string", minLength: 1 },
    missingUnitIds: { type: "array", items: { type: "string" } },
    retryUnitIds: { type: "array", items: { type: "string" } },
    selectedUnitIds: { type: "array", items: { type: "string" } },
    invalidReceiptPaths: { type: "array", items: { type: "string" } },
    needsDomainLabels: { type: "boolean" },
    domains: { type: "integer", minimum: 0 },
    flows: { type: "integer", minimum: 0 },
    summary: { type: "string", maxLength: 3000 },
  },
};

const ASSIGNMENTS = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "shards", "limits"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string", maxLength: 3000 },
    limits: { type: "object" },
    shards: {
      type: "array",
      items: {
        type: "object",
        required: ["owner", "role", "pagePaths"],
        properties: {
          owner: { type: "string" },
          role: { type: "string", enum: ["domain", "integration"] },
          pagePaths: { type: "array", items: { type: "string" } },
          sourceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const REVIEW = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "clean", "blockingCount", "majorCount", "repairTargets"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string", maxLength: 3000 },
    clean: { type: "boolean" },
    blockingCount: { type: "integer", minimum: 0 },
    majorCount: { type: "integer", minimum: 0 },
    defectFingerprint: { type: "string" },
    repairTargets: {
      type: "array",
      items: {
        type: "object",
        required: ["owner", "pagePaths"],
        properties: { owner: { type: "string" }, pagePaths: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

const input = args && typeof args === "object" ? args : { request: {} };
const request = input.request && typeof input.request === "object" ? input.request : input;
const mode = ["auto", "plan", "write", "restart", "retry-plan", "retry-write"].includes(request.mode) ? request.mode : "auto";
const focus = typeof request.focus === "string" && request.focus.trim() ? request.focus.trim() : undefined;

function hostResultPrompt(name, payload, instruction) {
  return [
    instruction,
    "Use the named OKF host tool exactly once; do not use bash or invent state.",
    "Return the host tool's JSON result, augmented only with the requested concise summary.",
    "Tool: " + name,
    "Payload: " + JSON.stringify(payload),
  ].join("\\n");
}

async function hostPrepare() {
  return agent(
    hostResultPrompt("okf_prepare", { mode, focus }, "Prepare the Wiki run. The core validates frozen snapshots and selects the next checkpoint edge."),
    { label: "bootstrap-prepare", schema: BOOTSTRAP },
  );
}

async function mergeSurvey(runId, pass, labelsPath) {
  return agent(
    hostResultPrompt("okf_survey_merge", { runId, pass, labelsPath }, "Merge completed survey receipts. The core owns discovery-map and checkpoint validation."),
    { label: "survey-merge:" + pass, schema: SURVEY_MERGE },
  );
}

async function publish(runId, phaseName, artifactsJsonPath) {
  return agent(
    hostResultPrompt("okf_publish", { runId, phase: phaseName, artifactsJsonPath }, "Publish one checkpoint after inspecting the declared artifact list."),
    { label: "publish:" + phaseName, schema: ENVELOPE },
  );
}

async function validate(runId) {
  return agent(
    hostResultPrompt("okf_validate", { runId }, "Validate and seal the candidate only after review and repair are complete."),
    { label: "validate-candidate", schema: ENVELOPE },
  );
}

return await (async () => {
  phase("Bootstrap");
  const bootstrap = await hostPrepare();
  if (!bootstrap || bootstrap.status !== "ok") return { status: "failed", bootstrap };
  const runId = bootstrap.runId;
  const workdir = bootstrap.workdir;
  let startAt = bootstrap.startAt;

  if (startAt === "sealed") return { status: "ok", domainRunId: runId, workdir, next: "sealed" };
  if (mode === "plan" && !["survey", "plan", "gate"].includes(startAt)) {
    return { status: "ok", domainRunId: runId, workdir, next: "/wiki --write", summary: "A gate-ready plan already exists." };
  }
  if (mode === "write" && ["survey", "plan", "gate"].includes(startAt)) {
    return { status: "blocked", domainRunId: runId, workdir, summary: "--write requires an approved plan checkpoint." };
  }

  if (["survey", "plan"].includes(startAt)) {
    if (startAt === "survey") {
      phase("Survey");
      const inventory = await agent(
        [
          "Read " + workdir + "/inputs/inventory.json and " + workdir + "/inputs/run-policy.json.",
          "Return coverage units and policy limits. Do not write control-plane files.",
          "All evidence must stay under " + workdir + "/sources/.",
        ].join("\\n"),
        { label: "load-inventory", schema: INVENTORY },
      );
      if (!inventory || inventory.status !== "ok" || !Array.isArray(inventory.units) || !inventory.units.length) {
        return { status: "failed", domainRunId: runId, inventory, summary: "No survey coverage units were available." };
      }

      const maxCoveragePasses = Math.max(1, Math.min(4, Number(inventory.limits?.maxCoveragePasses) || 2));
      let pendingUnits = inventory.units;
      let merged = null;
      for (let pass = 1; pass <= maxCoveragePasses && pendingUnits.length; pass++) {
        const unitGroups = [[], [], []];
        for (let i = 0; i < pendingUnits.length; i++) unitGroups[i % unitGroups.length].push(pendingUnits[i]);
        const surveys = await parallel(unitGroups.filter((group) => group.length).map((units, lane) => () => agent(
          [
            "Survey lane " + (lane + 1) + ", pass " + pass + ", for Wiki run " + runId + ".",
            "Read the survey method under " + workdir + "/method and frozen evidence under " + workdir + "/sources only.",
            "Survey exactly these coverage units: " + JSON.stringify(units) + ".",
            "Write one schema-shaped receipt per unit beneath " + workdir + "/analysis/receipts/survey/.",
            "Do not alter discovery-map, checkpoints, inventory, sources, or candidate pages.",
            "Return status and a compact receipt summary.",
          ].join("\\n"),
          { label: "survey:" + pass + ":" + (lane + 1), schema: ENVELOPE },
        )));
        if (surveys.some((result) => !result || result.status !== "ok")) {
          log("Some survey lanes failed; the deterministic merge will classify all receipts.");
        }
        merged = await mergeSurvey(runId, pass);
        if (!merged || merged.status !== "ok") return { status: "failed", domainRunId: runId, merged };
        if (merged.needsDomainLabels) {
          const labelsPath = "analysis/receipts/discovery-labels-pass-" + pass + ".json";
          const labels = await agent(
            [
              "Read only " + workdir + "/analysis/discovery-map.json.",
              "Write " + labelsPath + " as JSON {domains,flows}; every item needs id, summary, coverageUnitIds and flows may include crossSource.",
              "Provide at least one domain when the method requires domain labels. Do not modify the Discovery Map or receipts.",
            ].join("\\n"),
            { label: "discovery-labels:" + pass, schema: ENVELOPE },
          );
          if (!labels || labels.status !== "ok") return { status: "failed", domainRunId: runId, labels };
          merged = await mergeSurvey(runId, pass, labelsPath);
          if (!merged || merged.status !== "ok") return { status: "failed", domainRunId: runId, merged };
        }
        const retry = new Set((merged.retryUnitIds || []).map(String));
        pendingUnits = inventory.units.filter((unit) => retry.has(String(unit.id)));
      }
      if (!merged || merged.missingUnitIds?.length) {
        return { status: "failed", domainRunId: runId, merged, summary: "Survey coverage remains missing after its pass budget." };
      }
      const discover = await publish(runId, "discover", merged.artifactsPath);
      if (!discover || discover.status !== "ok") return { status: "failed", domainRunId: runId, discover };
    }

    phase("Plan");
    const planned = await agent(
      [
        "Plan the Wiki run " + runId + ".",
        "Read the plan method, discovery map, inventory, policy, and authoritative checkpoint in " + workdir + ".",
        "Write analysis/spec.json, analysis/page-assignments.json, and analysis/receipts/plan-artifacts.json.",
        "Every candidate page must have exactly one owner; record dependencies and coverage bindings.",
        "Do not write candidate pages or mutate checkpoints.",
      ].join("\\n"),
      { label: "plan-spec", schema: ENVELOPE },
    );
    if (!planned || planned.status !== "ok") return { status: "failed", domainRunId: runId, planned };
    const plan = await publish(runId, "plan", "analysis/receipts/plan-artifacts.json");
    if (!plan || plan.status !== "ok") return { status: "failed", domainRunId: runId, plan };
    startAt = "gate";
  }

  if (startAt === "gate") {
    // Gate approval is an interactive command action. A background subagent
    // must never approve its own plan, even if it can inspect the gate state.
    phase("Gate");
    return { status: "ok", domainRunId: runId, workdir, next: "/wiki --write", summary: "Plan checkpointed and awaiting explicit approval." };
  }

  // A resumed review/repair run does not pass through the write stage, but it
  // still needs authoritative ownership and repair limits. Load once after the
  // plan gate, then share it between writing and verification.
  let assignments = null;
  if (startAt !== "validate") {
    assignments = await agent(
      [
        "Read analysis/spec.json, analysis/page-assignments.json, and inputs/run-policy.json in " + workdir + ".",
        "Return domain and integration ownership shards, dependencies, and page paths. Do not mutate files.",
      ].join("\\n"),
      { label: "load-page-assignments", schema: ASSIGNMENTS },
    );
    if (!assignments || assignments.status !== "ok" || !Array.isArray(assignments.shards)) {
      return { status: "failed", domainRunId: runId, assignments, summary: "Page assignments could not be loaded." };
    }
  }

  if (["ready", "write-sources", "write"].includes(startAt)) {
    phase("Write");
    const sourceShards = assignments.shards.filter((shard) => shard && shard.role !== "integration");
    const integrationShards = assignments.shards.filter((shard) => shard && shard.role === "integration");
    if (startAt === "ready") startAt = "write-sources";

    if (startAt === "write-sources") {
      const sourceWriters = await parallel(sourceShards.map((shard, index) => () => agent(
        [
          "Write source/domain candidate pages for the owned shard " + JSON.stringify(shard) + " in Wiki run " + runId + ".",
          "Read the generate method, authoritative plan, and frozen sources. Write only pages owned by this shard under " + workdir + "/candidate/.",
          "Use source-grounded claims and local citations. Do not edit integration pages, analysis checkpoints, inputs, or sources.",
        ].join("\\n"),
        { label: "write-sources:" + (index + 1), schema: ENVELOPE },
      )));
      if (sourceWriters.some((result) => !result || result.status !== "ok")) return { status: "failed", domainRunId: runId, sourceWriters };
      const sourceReduce = await agent(
        [
          "Inspect completed source/domain candidate pages and assignments for run " + runId + ".",
          "Write analysis/receipts/write-sources-artifacts.json listing only source/domain candidate artifacts. Do not change pages or checkpoints.",
        ].join("\\n"),
        { label: "reduce-write-sources", schema: ENVELOPE },
      );
      if (!sourceReduce || sourceReduce.status !== "ok") return { status: "failed", domainRunId: runId, sourceReduce };
      const sourceWritten = await publish(runId, "write-sources", "analysis/receipts/write-sources-artifacts.json");
      if (!sourceWritten || sourceWritten.status !== "ok") return { status: "failed", domainRunId: runId, sourceWritten };
      startAt = "write";
    }

    if (startAt === "write") {
      const integrationWriters = await parallel(integrationShards.map((shard, index) => () => agent(
        [
          "Write integration candidate pages for the owned shard " + JSON.stringify(shard) + " in Wiki run " + runId + ".",
          "Read the generate method, authoritative plan, completed source/domain candidate pages, and frozen sources.",
          "Write only pages owned by this integration shard under " + workdir + "/candidate/ and retain local citations.",
        ].join("\\n"),
        { label: "write-integration:" + (index + 1), schema: ENVELOPE },
      )));
      if (integrationWriters.some((result) => !result || result.status !== "ok")) {
        return { status: "failed", domainRunId: runId, integrationWriters };
      }
      const reduce = await agent(
        [
          "Inspect all candidate pages and assignments for run " + runId + ".",
          "Write analysis/receipts/write-artifacts.json listing final candidate artifacts. Do not change pages or checkpoints.",
        ].join("\\n"),
        { label: "reduce-write", schema: ENVELOPE },
      );
      if (!reduce || reduce.status !== "ok") return { status: "failed", domainRunId: runId, reduce };
      const written = await publish(runId, "write", "analysis/receipts/write-artifacts.json");
      if (!written || written.status !== "ok") return { status: "failed", domainRunId: runId, written };
      startAt = "review-1";
    }
  }

  function reviewSnapshot(review) {
    return {
      defectFingerprint: typeof review?.defectFingerprint === "string" ? review.defectFingerprint : "",
      blockingCount: Math.max(0, Number(review?.blockingCount) || 0),
      majorCount: Math.max(0, Number(review?.majorCount) || 0),
    };
  }

  function reviewProgress(previous, current) {
    const before = reviewSnapshot(previous);
    const after = reviewSnapshot(current);
    if (before.defectFingerprint && after.defectFingerprint && before.defectFingerprint === after.defectFingerprint) {
      return { ok: false, reason: "defect fingerprint repeated" };
    }
    if (after.blockingCount < before.blockingCount || (after.blockingCount === before.blockingCount && after.majorCount < before.majorCount)) {
      return { ok: true };
    }
    return { ok: false, reason: "blocking/major defect counts did not decrease" };
  }

  let finalReview = startAt === "validate" ? { clean: true, resumed: true } : null;
  if (startAt !== "validate") {
    let reviewRound = Number((/^review-(\d+)$/.exec(startAt) || /^repair-(\d+)$/.exec(startAt) || [])[1] || 1);
    let resumeRepair = /^repair-\d+$/.test(startAt);
    const maxRepairRounds = Math.max(1, Math.min(2, Number(assignments.limits?.maxRepairRounds) || 2));
    let completedRepairRounds = Math.max(0, reviewRound - 1);
    let previousReview = null;

    if (!resumeRepair && reviewRound > 1) {
      const baseline = await agent(
        [
          "Resume review round " + reviewRound + " for Wiki run " + runId + ".",
          "Read the current analysis/defects.json produced before repair and return its stable fingerprint, blocking/major counts, and repair targets without changing files.",
        ].join("\\n"),
        { label: "hydrate-review-baseline:" + (reviewRound - 1), schema: REVIEW },
      );
      if (!baseline || baseline.status !== "ok" || baseline.clean) return { status: "failed", domainRunId: runId, baseline };
      previousReview = baseline;
    }

    while (reviewRound <= maxRepairRounds + 1) {
      if (resumeRepair) {
        phase("Repair");
        const stored = await agent(
          [
            "Resume repair round " + reviewRound + " for Wiki run " + runId + ".",
            "Read analysis/defects.json, page assignments, and the current review checkpoint. Return clean=false and exact repairTargets without changing files.",
          ].join("\\n"),
          { label: "hydrate-repair:" + reviewRound, schema: REVIEW },
        );
        if (!stored || stored.status !== "ok" || stored.clean) return { status: "failed", domainRunId: runId, stored };
        previousReview = stored;
        const resumedRepairs = await parallel((stored.repairTargets || []).map((target, index) => () => agent(
          [
            "Repair owner " + target.owner + " for Wiki run " + runId + ".",
            "Read analysis/defects.json, assigned Spec entries, page assignments, and frozen sources.",
            "Modify only these candidate pages: " + JSON.stringify(target.pagePaths) + ". Write no control-plane files.",
          ].join("\\n"),
          { label: "repair-resume:" + reviewRound + ":" + index, schema: ENVELOPE },
        )));
        if (resumedRepairs.some((result) => !result || result.status !== "ok")) return { status: "failed", domainRunId: runId, resumedRepairs };
        const reducedResume = await agent(
          "Write an immutable repair receipt under analysis/receipts/repair/ for round " + reviewRound + ", then write analysis/receipts/repair-artifacts-round-" + reviewRound + ".json as a JSON array of {id,type,path} declaring only that receipt. Never declare candidate pages or analysis/defects.json because later rounds may change them.",
          { label: "reduce-repair-resume:" + reviewRound, schema: ENVELOPE },
        );
        if (!reducedResume || reducedResume.status !== "ok") return { status: "failed", domainRunId: runId, reducedResume };
        const repairedResume = await publish(runId, "repair-" + reviewRound, "analysis/receipts/repair-artifacts-round-" + reviewRound + ".json");
        if (!repairedResume || repairedResume.status !== "ok") return { status: "failed", domainRunId: runId, repairedResume };
        completedRepairRounds++;
        reviewRound++;
        resumeRepair = false;
        if (reviewRound > maxRepairRounds + 1) return { status: "failed", domainRunId: runId, stopped: "repair budget exhausted" };
      }

      phase("Verify");
      const lenses = ["source-claims", "coverage-and-ownership", "navigation-and-reader-utility"];
      const reviews = await parallel(lenses.map((lens) => () => agent(
        [
          "Independently review Wiki run " + runId + ", round " + reviewRound + ", through the " + lens + " lens.",
          "Read frozen sources, candidate pages, Spec, assignments, and the review method.",
          "Write one schema-shaped finding receipt beneath analysis/receipts/review/ for this round. Do not repair pages or alter control-plane artifacts.",
        ].join("\\n"),
        { label: "review:" + reviewRound + ":" + lens, schema: ENVELOPE },
      )));
      if (reviews.some((result) => !result || result.status !== "ok")) return { status: "failed", domainRunId: runId, reviews };
      finalReview = await agent(
        [
          "Defect reducer for review round " + reviewRound + " in Wiki run " + runId + ".",
          "Read all receipts under analysis/receipts/review/ for this round, Spec, page assignments, and candidate pages.",
          "Write analysis/defects.json conforming to defects.schema.json version 2, and analysis/receipts/review-artifacts-round-" + reviewRound + ".json as a JSON array of {id,type,path}. The artifact list may include only immutable round receipt files; never include analysis/defects.json because it is mutable current state.",
          "Every defect must identify pagePath, owner, severity, category, evidence, repairSuggestion, and a stable fingerprint. clean=true only with no defects.",
          "Return exact clean state, blocking/major counts, repairTargets grouped by owner, and defectFingerprint as a deterministic digest of active defect fingerprints.",
        ].join("\\n"),
        { label: "reduce-review:" + reviewRound, schema: REVIEW },
      );
      if (!finalReview || finalReview.status !== "ok") return { status: "failed", domainRunId: runId, finalReview };
      const reviewed = await publish(runId, "review-" + reviewRound, "analysis/receipts/review-artifacts-round-" + reviewRound + ".json");
      if (!reviewed || reviewed.status !== "ok") return { status: "failed", domainRunId: runId, reviewed };
      if (finalReview.clean) break;
      if (previousReview) {
        const progress = reviewProgress(previousReview, finalReview);
        if (!progress.ok) {
          return { status: "failed", domainRunId: runId, finalReview, stopped: progress.reason };
        }
      }
      if (completedRepairRounds >= maxRepairRounds) {
        return { status: "failed", domainRunId: runId, finalReview, stopped: "repair budget exhausted with unresolved defects" };
      }

      phase("Repair");
      const repairs = await parallel((finalReview.repairTargets || []).map((target, index) => () => agent(
        [
          "Repair owner " + target.owner + " for Wiki run " + runId + ", round " + reviewRound + ".",
          "Read analysis/defects.json, assigned Spec entries, page assignments, and frozen sources.",
          "Modify only these candidate pages: " + JSON.stringify(target.pagePaths) + ". Do not write checkpoints, inputs, or source snapshots.",
        ].join("\\n"),
        { label: "repair:" + reviewRound + ":" + index, schema: ENVELOPE },
      )));
      if (repairs.some((result) => !result || result.status !== "ok")) return { status: "failed", domainRunId: runId, repairs };
      const reduced = await agent(
        "Write an immutable repair receipt under analysis/receipts/repair/ for round " + reviewRound + ", then write analysis/receipts/repair-artifacts-round-" + reviewRound + ".json as a JSON array of {id,type,path} declaring only that receipt. Never declare candidate pages or analysis/defects.json because later rounds may change them.",
        { label: "reduce-repair:" + reviewRound, schema: ENVELOPE },
      );
      if (!reduced || reduced.status !== "ok") return { status: "failed", domainRunId: runId, reduced };
      const repaired = await publish(runId, "repair-" + reviewRound, "analysis/receipts/repair-artifacts-round-" + reviewRound + ".json");
      if (!repaired || repaired.status !== "ok") return { status: "failed", domainRunId: runId, repaired };
      previousReview = finalReview;
      completedRepairRounds++;
      reviewRound++;
    }
  }

  if (!finalReview?.clean) return { status: "failed", domainRunId: runId, finalReview, stopped: "candidate has unresolved defects" };

  phase("Validate");
  const sealed = await validate(runId);
  if (!sealed || sealed.status !== "ok") {
    return { status: "failed", domainRunId: runId, workdir, sealed };
  }
  const validationCheckpoint = await publish(runId, "validate", sealed.artifactsJsonPath || "analysis/receipts/validate-artifacts.json");
  return {
    status: validationCheckpoint && validationCheckpoint.status === "ok" ? "ok" : "failed",
    domainRunId: runId,
    workflowRunId: input.workflowRunId,
    workdir,
    sealed,
    validationCheckpoint,
  };
})();
`;
