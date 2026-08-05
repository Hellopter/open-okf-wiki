/**
 * wiki - single-command, checkpointed repository wiki production workflow.
 *
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 * The host CLI owns run state and checkpoint authority. Agents own only
 * run-local data-plane artifacts and return bounded handoff envelopes.
 */

export const meta = {
  name: "wiki",
  description: "Produce a source-grounded Wiki through checkpointed survey, planning, writing, verification, repair, and sealing",
  phases: [
    { title: "Bootstrap", detail: "prepare or resume a checkpointed run" },
    { title: "Survey", detail: "fan out frozen-source discovery in bounded waves" },
    { title: "Plan", detail: "assign owned pages and gate the plan" },
    { title: "Write", detail: "write domain shards, then integration shards" },
    { title: "Verify", detail: "independently refute unsupported claims" },
    { title: "Repair", detail: "route defects back to page owners" },
    { title: "Validate", detail: "mechanically validate and seal" },
  ],
};

const MAX_CONCURRENCY = 8;
const MAX_SURVEY_PASSES = 2;
const MAX_REPAIR_ROUNDS = 2;

const ENVELOPE = {
  type: "object",
  additionalProperties: false,
  required: ["status", "proposalPath", "summary", "openQuestions"],
  properties: {
    status: { type: "string", enum: ["ok", "failed", "skipped"] },
    proposalPath: { type: "string", minLength: 1, maxLength: 500 },
    summary: { type: "string", maxLength: 6000 },
    openQuestions: { type: "array", items: { type: "string", maxLength: 2000 } },
  },
};

const CHECKPOINT = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checkpointPath", "checkpointDigest", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    checkpointPath: { type: "string", minLength: 1 },
    checkpointDigest: { type: "string", minLength: 16 },
    summary: { type: "string", maxLength: 6000 },
  },
};

const BOOTSTRAP = {
  type: "object",
  additionalProperties: false,
  required: ["status", "runId", "workdir", "workspaceRoot", "mode", "startAt"],
  properties: {
    ok: { type: "boolean" },
    status: { type: "string", enum: ["ok", "failed"] },
    runId: { type: "string", minLength: 1 },
    workdir: { type: "string", minLength: 1 },
    workspaceRoot: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["auto", "plan", "write", "retry-plan", "retry-write"] },
    startAt: { type: "string", enum: ["survey", "plan", "write", "validate"] },
    inputCheckpointDigest: { type: ["string", "null"] },
    summary: { type: "string", maxLength: 6000 },
  },
};

const INVENTORY = {
  type: "object",
  additionalProperties: false,
  required: ["units", "tier", "sourceCount", "wikiLanguage"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          kind: { type: "string" },
          sourceId: { type: "string" },
          path: { type: "string" },
          label: { type: "string" },
        },
      },
    },
    tier: { type: "string" },
    sourceCount: { type: "number" },
    wikiLanguage: { type: "string", enum: ["en", "zh"] },
    focus: { type: ["string", "null"] },
  },
};

const RESUMED_DISCOVERY = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checkpointPath", "checkpointDigest", "wikiLanguage", "sourceCount", "tier", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    checkpointPath: { type: "string", minLength: 1 },
    checkpointDigest: { type: "string", minLength: 16 },
    wikiLanguage: { type: "string", enum: ["en", "zh"] },
    sourceCount: { type: "number" },
    tier: { type: "string" },
    focus: { type: ["string", "null"] },
    summary: { type: "string", maxLength: 6000 },
  },
};

const DISCOVERY = {
  type: "object",
  additionalProperties: false,
  required: ["status", "proposalPath", "summary", "openQuestions", "missingUnitIds"],
  properties: {
    ...ENVELOPE.properties,
    missingUnitIds: { type: "array", items: { type: "string", minLength: 1 } },
  },
};

const ASSIGNMENTS = {
  type: "object",
  additionalProperties: false,
  required: ["wikiLanguage", "sourceCount", "tier", "shards"],
  properties: {
    wikiLanguage: { type: "string", enum: ["en", "zh"] },
    sourceCount: { type: "number" },
    tier: { type: "string" },
    shards: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "role", "pagePaths", "dependsOn"],
        properties: {
          owner: { type: "string", minLength: 1 },
          role: { type: "string", enum: ["domain", "integration"] },
          pagePaths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          coverageUnitIds: { type: "array", items: { type: "string", minLength: 1 } },
          dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
          sourceIds: { type: "array", items: { type: "string", minLength: 1 } },
          contractIds: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
};

const REVIEW = {
  type: "object",
  additionalProperties: false,
  required: ["status", "proposalPath", "summary", "openQuestions", "clean", "blockingCount", "majorCount", "defectFingerprint", "repairTargets"],
  properties: {
    ...ENVELOPE.properties,
    clean: { type: "boolean" },
    blockingCount: { type: "integer", minimum: 0 },
    majorCount: { type: "integer", minimum: 0 },
    defectFingerprint: { type: "string", minLength: 16, maxLength: 256 },
    repairTargets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "pagePaths"],
        properties: {
          owner: { type: "string", minLength: 1 },
          pagePaths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
};

function normalizeArgs(value) {
  const validModes = new Set(["auto", "plan", "write", "retry-plan", "retry-write"]);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mode = validModes.has(value.mode) ? value.mode : "auto";
    const focus = typeof value.focus === "string" && value.focus.trim() ? value.focus.trim() : undefined;
    return { mode, focus };
  }
  const text = typeof value === "string" ? value.trim() : "";
  const match = text.match(/^(--plan|--write|--retry\s+plan|--retry\s+write)(?:\s+|$)([\s\S]*)$/);
  if (!match) return { mode: "auto", focus: text || undefined };
  const mode = {
    "--plan": "plan",
    "--write": "write",
    "--retry plan": "retry-plan",
    "--retry write": "retry-write",
  }[match[1].replace(/\s+/g, " ")];
  const focus = match[2].trim();
  return { mode, focus: focus || undefined };
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 80) || "item";
}

function waves(items) {
  const output = [];
  for (let offset = 0; offset < items.length; offset += MAX_CONCURRENCY) {
    output.push(items.slice(offset, offset + MAX_CONCURRENCY));
  }
  return output;
}

function languageDirective(wikiLanguage, scope) {
  const isChinese = wikiLanguage === "zh";
  const language = isChinese ? "Simplified Chinese" : "English";
  return [
    `wikiLanguage=${isChinese ? "zh" : "en"}.`,
    `All human-readable ${scope} MUST be ${language}.`,
    "Keep source identifiers, paths, APIs, package names, and code tokens untranslated.",
  ].join(" ");
}

function multiSourceDirective(sourceCount, tier) {
  if (!(sourceCount >= 2 || tier === "L3")) return "";
  return [
    "MULTI-SOURCE DEEP ANALYSIS REQUIRED.",
    "Keep each source substantively represented with grounded purpose, public surfaces, key modules, and contracts.",
    "Plan repository/surface mapping and a cited cross-source flow unless a structured cancellation explains why none exists.",
    "Do not replace architecture evidence with a thin overview or an uncited synthesis.",
  ].join(" ");
}

function conciseLedger(entries) {
  return entries.map(({ id, owner, status, proposalPath, summary }) => ({ id, owner, status, proposalPath, summary }));
}

async function runCheckpoint({ agent, workdir, phaseName, proposalPath, label }) {
  return agent(
    [
      `Checkpoint authority. workdir=${workdir}.`,
      `Read ${workdir}/inputs/run-policy.json to obtain hostCli.{node,script,workspaceRoot}.`,
      `Read and validate the run-local handoff proposal at ${proposalPath}. Do not modify its artifacts.`,
      `Run exactly: <hostCli.node> <hostCli.script> checkpoint --phase ${phaseName} --proposal ${proposalPath} --workspace <hostCli.workspaceRoot>, substituting hostCli values.`,
      "The host command must recompute artifact digests, validate ownership/dependencies, atomically write analysis/checkpoints/<phase>.json, and update current state.",
      "Artifact dependsOn entries may reference only artifacts from published predecessor checkpoints or their checkpoint digest, never uncheckpointed child handoff ids.",
      "Return status=ok only for a zero exit code and include checkpointPath and checkpointDigest from its JSON output.",
    ].join("\n"),
    { label, schema: CHECKPOINT },
  );
}

return await (async () => {
  const input = normalizeArgs(args);

  phase("Bootstrap");
  const bootstrap = await agent(
    [
      "Bootstrap a Wiki v2 run. Read .wiki-agent/runtime.json in this workspace; it is the only host-command authority.",
      `Requested business input: ${JSON.stringify(input)}.`,
      "Invoke the runtime manifest's exact node/script with `prepare --mode <requested mode>`.",
      "Pass focus only as one safely quoted argument when it is present. Do not synthesize or accept runId/workdir input.",
      "prepare must create or resolve the run, apply retry cleanup when requested, and choose startAt=survey|plan|write from authoritative checkpoints.",
      "Return the prepare JSON fields. Fail closed when write is requested without a valid plan checkpoint.",
    ].join("\n"),
    { label: "bootstrap-prepare", schema: BOOTSTRAP },
  );
  if (bootstrap?.status !== "ok") return { stopped: "prepare failed", input, bootstrap };

  const { runId, workdir, workspaceRoot } = bootstrap;
  if (!runId || !workdir || !workspaceRoot) return { stopped: "prepare returned incomplete run context", input, bootstrap };
  const methodRoot = `${workdir}/method`;
  const shouldPlan = bootstrap.startAt === "survey" || bootstrap.startAt === "plan";
  if (input.mode === "plan" && !shouldPlan) {
    return {
      runId,
      workdir,
      workspaceRoot,
      mode: input.mode,
      stopped: "a gate-ready plan already exists",
      next: bootstrap.startAt === "write" ? "/wiki --write" : "/wiki",
    };
  }
  if (input.mode === "write" && shouldPlan) {
    return { runId, workdir, workspaceRoot, stopped: "--write requires an authoritative plan checkpoint" };
  }

  let inventory = null;
  let surveyLedger = [];
  let discovery = null;
  let discoveryCheckpoint = null;
  let plan = null;
  let planCheckpoint = null;
  let wikiLanguage = "en";
  let sourceCount = 1;
  let tier = "L0";
  let focusRule = "";
  let multiSource = "";

  if (shouldPlan) {
    const resumePlan = bootstrap.startAt === "plan";
    if (!resumePlan) {
      phase("Survey");
    inventory = await agent(
      [
        `Read ${workdir}/inputs/inventory.json and ${workdir}/inputs/run-policy.json.`,
        "Return coverage units and only policy controls needed for topology. Do not return source bodies.",
        "Each coverage unit must preserve id, kind, sourceId, path, and label when present.",
      ].join("\n"),
      { label: "load-inventory", schema: INVENTORY },
    );
    if (!inventory?.units?.length) return { runId, workdir, stopped: "inventory has no coverage units", inventory };

    wikiLanguage = inventory.wikiLanguage === "zh" ? "zh" : "en";
    sourceCount = Number.isFinite(inventory.sourceCount) ? inventory.sourceCount : 1;
    tier = typeof inventory.tier === "string" ? inventory.tier : "L0";
    const surveyLanguage = languageDirective(wikiLanguage, "survey receipts, labels, and planning prose");
    multiSource = multiSourceDirective(sourceCount, tier);
    focusRule = inventory.focus ? `Operator focus: ${inventory.focus}` : "";
    let pendingUnits = inventory.units;

    for (let pass = 1; pass <= MAX_SURVEY_PASSES && pendingUnits.length; pass++) {
      for (const wave of waves(pendingUnits)) {
        const results = await parallel(
          wave.map((unit) => () => {
            const id = safeId(unit.id);
            const proposalPath = `analysis/handoffs/survey/${id}-pass-${pass}.json`;
            return agent(
              [
                `Surveyor for coverage unit ${JSON.stringify(unit)}. workdir=${workdir}.`,
                `Read ${methodRoot}/references/research.md and ${workdir}/inputs/run-policy.json in full.`,
                surveyLanguage,
                multiSource,
                focusRule,
                `Read frozen evidence only under ${workdir}/sources/.`,
                "Prioritize entry points, public surfaces, runtime paths, module boundaries, and cross-source contracts.",
                `Write the detailed receipt under analysis/receipts/survey/${id}-pass-${pass}.json.`,
                `Write the handoff proposal to ${proposalPath}; declare the receipt artifact, this coverage unit, source-relative evidence, and open questions.`,
                "Return only the bounded handoff envelope. Do not write candidate pages.",
              ].filter(Boolean).join("\n"),
              { label: `survey:${pass}:${id}`, schema: ENVELOPE },
            );
          }),
        );
        surveyLedger.push(
          ...wave.map((unit, index) => ({
            id: String(unit.id),
            status: results[index]?.status ?? "failed",
            proposalPath: results[index]?.proposalPath ?? `analysis/handoffs/survey/${safeId(unit.id)}-pass-${pass}.json`,
            summary: results[index]?.summary ?? "surveyor returned no envelope",
          })),
        );
      }

      discovery = await agent(
        [
          `Discovery reducer. workdir=${workdir}. Read ${methodRoot}/references/research.md.`,
          `Read inventory and run policy, then JIT-read only survey handoffs/receipts in this ledger: ${JSON.stringify(conciseLedger(surveyLedger))}.`,
          surveyLanguage,
          multiSource,
          `Write ${workdir}/analysis/discovery-map.json with complete coverage units, domains, flows, concepts, and visible failed/cancelled units.`,
          "Return missingUnitIds only for required coverage that is still surveyable; do not guess missing evidence.",
          `Write the aggregate discovery handoff proposal to analysis/handoffs/discovery-pass-${pass}.json with inputCheckpointDigests exactly []; it MUST declare analysis/discovery-map.json as a discovery-map artifact plus the survey receipt artifacts it reduces.`,
          "Return only the bounded discovery envelope.",
        ].filter(Boolean).join("\n"),
        { label: `reduce-discovery:${pass}`, schema: DISCOVERY },
      );
      if (discovery?.status !== "ok") return { runId, workdir, surveyLedger, discovery, stopped: "discovery reduction failed" };
      const missing = new Set(discovery.missingUnitIds ?? []);
      pendingUnits = pass < MAX_SURVEY_PASSES ? inventory.units.filter((unit) => missing.has(unit.id)) : [];
    }

    discoveryCheckpoint = await runCheckpoint({
      agent,
      workdir,
      phaseName: "discover",
      proposalPath: discovery.proposalPath,
      label: "checkpoint-discover",
    });
    if (discoveryCheckpoint?.status !== "ok") {
      return { runId, workdir, surveyLedger, discovery, discoveryCheckpoint, stopped: "discovery checkpoint failed" };
    }
    } else {
      const resumedDiscovery = await agent(
        [
          `Resume planner input. workdir=${workdir}.`,
          "Read the current v2 run state, inputs/run-policy.json, inputs/inventory.json, and analysis/checkpoints/discover.json.",
          "Return the authoritative discover checkpoint path/digest and policy controls only. Fail closed if the checkpoint or its artifacts are stale.",
        ].join("\n"),
        { label: "hydrate-discovery-checkpoint", schema: RESUMED_DISCOVERY },
      );
      if (resumedDiscovery?.status !== "ok") return { runId, workdir, resumedDiscovery, stopped: "cannot resume plan without a valid discovery checkpoint" };
      discoveryCheckpoint = resumedDiscovery;
      wikiLanguage = resumedDiscovery.wikiLanguage;
      sourceCount = resumedDiscovery.sourceCount;
      tier = resumedDiscovery.tier;
      focusRule = resumedDiscovery.focus ? `Operator focus: ${resumedDiscovery.focus}` : "";
      multiSource = multiSourceDirective(sourceCount, tier);
    }

    phase("Plan");
    plan = await agent(
      [
        `Planner. workdir=${workdir}. Read ${methodRoot}/references/plan.md in full.`,
        `Read ${workdir}/analysis/discovery-map.json, ${workdir}/inputs/inventory.json, and ${workdir}/inputs/run-policy.json; JIT-read evidence from the discovery checkpoint only as needed.`,
        languageDirective(wikiLanguage, "Spec titles, questions, labels, and prose"),
        multiSource,
        focusRule,
        "Write analysis/spec.json conforming to schemas/spec.schema.json version 2.",
        "Write analysis/page-assignments.json as the same pageAssignments control plane from the Spec, grouped only for convenient reading.",
        "Every candidate page must have one owner and one candidate path. Domain owners may write only their assigned pages. Integration owners exclusively own overview, navigation, terminology, and cross-source-flow pages.",
        "Every assignment must declare coverage units and handoff dependencies. Bind every required coverage unit or record a structured cancellation.",
        `Write a plan handoff proposal to analysis/handoffs/plan.json with inputCheckpointDigests exactly [${discoveryCheckpoint.checkpointDigest}]; declare spec and page assignments as artifacts that depend on that discovery checkpoint.`,
        "Do not write candidate pages. Return only the bounded handoff envelope.",
      ].filter(Boolean).join("\n"),
      { label: "plan-spec", schema: ENVELOPE },
    );
    if (plan?.status !== "ok") return { runId, workdir, discoveryCheckpoint, plan, stopped: "plan generation failed" };

    planCheckpoint = await runCheckpoint({
      agent,
      workdir,
      phaseName: "plan",
      proposalPath: plan.proposalPath,
      label: "checkpoint-plan",
    });
    if (planCheckpoint?.status !== "ok") return { runId, workdir, plan, planCheckpoint, stopped: "plan checkpoint failed" };

    const gate = await agent(
      [
        `Plan gate. Read ${workdir}/inputs/run-policy.json for hostCli.`,
        `Run exactly: <hostCli.node> <hostCli.script> gate plan --run ${runId} --workspace <hostCli.workspaceRoot>, substituting hostCli values.`,
        `The gate receipt must bind plan checkpoint digest ${planCheckpoint.checkpointDigest}.`,
        `Write command output to ${workdir}/analysis/receipts/gate-plan.json.`,
        "Set proposalPath in the bounded envelope to analysis/receipts/gate-plan.json; no checkpoint is published for this command receipt.",
        "Return status=ok only after the deterministic gate succeeds. Do not rewrite a sealed checkpoint or its proposal.",
        "Return only the bounded handoff envelope.",
      ].join("\n"),
      { label: "gate-plan", schema: ENVELOPE },
    );
    if (gate?.status !== "ok") return { runId, workdir, discoveryCheckpoint, plan, gate, stopped: "plan gate failed" };

    if (input.mode === "plan") {
      log(`plan checkpointed for ${runId}; wait for explicit /wiki --write`);
      return { runId, workdir, workspaceRoot, mode: input.mode, discoveryCheckpoint, planCheckpoint, next: "/wiki --write" };
    }
  }

  let finalReviewCheckpoint = null;
  let finalReview = null;
  if (bootstrap.startAt === "validate") {
    if (typeof bootstrap.inputCheckpointDigest !== "string" || !bootstrap.inputCheckpointDigest) {
      return { runId, workdir, stopped: "validate resume has no final review checkpoint digest" };
    }
    finalReviewCheckpoint = { checkpointDigest: bootstrap.inputCheckpointDigest };
    finalReview = { clean: true, resumed: true };
  }

  if (bootstrap.startAt !== "validate") {
  phase("Write");
  const preflight = await agent(
    [
      `Write preflight. workdir=${workdir}. Read run policy and the authoritative plan checkpoint.`,
      `Run exactly: <hostCli.node> <hostCli.script> gate check --run ${runId} --workspace <hostCli.workspaceRoot>, substituting hostCli from run policy.`,
      "Fail if the plan checkpoint/gate is stale or missing, the candidate is already sealed, or page assignments have no unique ownership.",
      "Write analysis/receipts/preflight.json and a handoff proposal at analysis/handoffs/preflight.json. Return only the bounded handoff envelope.",
    ].join("\n"),
    { label: "preflight-write", schema: ENVELOPE },
  );
  if (preflight?.status !== "ok") return { runId, workdir, preflight, stopped: "write preflight failed" };
  const activePlanCheckpointDigest = planCheckpoint?.checkpointDigest ?? bootstrap.inputCheckpointDigest;
  if (typeof activePlanCheckpointDigest !== "string" || !activePlanCheckpointDigest) {
    return { runId, workdir, preflight, stopped: "write run has no authoritative plan checkpoint digest" };
  }

  const assignmentState = await agent(
    [
      `Read ${workdir}/analysis/spec.json and ${workdir}/analysis/page-assignments.json.`,
      "Validate that each page path appears exactly once, every page owner is declared, and integration pages are separate from domain pages.",
      "Return only compact owner shards, grouped by owner, with assigned page paths and declared checkpoint dependencies. Do not return page bodies.",
    ].join("\n"),
    { label: "load-page-assignments", schema: ASSIGNMENTS },
  );
  if (!assignmentState?.shards?.length) return { runId, workdir, assignmentState, stopped: "no valid page assignments" };
  wikiLanguage = assignmentState.wikiLanguage === "zh" ? "zh" : wikiLanguage;
  sourceCount = Number.isFinite(assignmentState.sourceCount) ? assignmentState.sourceCount : sourceCount;
  tier = typeof assignmentState.tier === "string" ? assignmentState.tier : tier;
  const writeLanguage = languageDirective(wikiLanguage, "candidate page titles, headings, and prose");
  const writeMultiSource = multiSourceDirective(sourceCount, tier);
  const domainShards = assignmentState.shards.filter((shard) => shard.role === "domain");
  const integrationShards = assignmentState.shards.filter((shard) => shard.role === "integration");
  const writeLedger = [];

  for (const wave of waves(domainShards)) {
    const results = await parallel(
      wave.map((shard) => () => {
        const id = safeId(shard.owner);
        return agent(
          [
            `Domain writer owner=${shard.owner}. workdir=${workdir}.`,
            `Read ${methodRoot}/references/generate.md, run policy, Spec, plan checkpoint ${activePlanCheckpointDigest}, and only the handoffs declared by this shard: ${JSON.stringify(shard.dependsOn)}.`,
            writeLanguage,
            writeMultiSource,
            `Your exclusive candidate pages: ${JSON.stringify(shard.pagePaths)}. Write no other candidate page, index, navigation, or log.`,
            `Re-open frozen evidence under ${workdir}/sources/ for every source claim. Use valid local relative Source Citations; never invent ranges.`,
            `Write a domain handoff proposal to analysis/handoffs/write/domain-${id}.json with inputCheckpointDigests exactly [${activePlanCheckpointDigest}], declaring candidate paths, coverage, dependencies, and evidence receipts.`,
            "Return only the bounded handoff envelope.",
          ].filter(Boolean).join("\n"),
          { label: `write:domain:${id}`, schema: ENVELOPE },
        );
      }),
    );
    writeLedger.push(
      ...wave.map((shard, index) => ({
        id: `domain:${shard.owner}`,
        owner: shard.owner,
        status: results[index]?.status ?? "failed",
        proposalPath: results[index]?.proposalPath ?? `analysis/handoffs/write/domain-${safeId(shard.owner)}.json`,
        summary: results[index]?.summary ?? "writer returned no envelope",
      })),
    );
  }
  if (writeLedger.some((entry) => entry.status !== "ok")) {
    return { runId, workdir, writeLedger, stopped: "one or more domain owners failed; no integration write is permitted" };
  }

  const sourceWriteProposal = await agent(
    [
      `Write-source reducer. workdir=${workdir}. JIT-read only these writer handoffs: ${JSON.stringify(conciseLedger(writeLedger))}.`,
      `Verify all domain owners completed their exclusive paths. Write analysis/handoffs/write-sources.json with inputCheckpointDigests exactly [${activePlanCheckpointDigest}] and the domain candidate artifacts/dependencies.`,
      "Return only the bounded handoff envelope.",
    ].join("\n"),
    { label: "reduce-write-sources", schema: ENVELOPE },
  );
  if (sourceWriteProposal?.status !== "ok") return { runId, workdir, writeLedger, sourceWriteProposal, stopped: "domain write reducer failed" };
  const sourceWriteCheckpoint = await runCheckpoint({
    agent,
    workdir,
    phaseName: "write-sources",
    proposalPath: sourceWriteProposal.proposalPath,
    label: "checkpoint-write-sources",
  });
  if (sourceWriteCheckpoint?.status !== "ok") return { runId, workdir, sourceWriteCheckpoint, stopped: "domain write checkpoint failed" };

  for (const wave of waves(integrationShards)) {
    const results = await parallel(
      wave.map((shard) => () => {
        const id = safeId(shard.owner);
        return agent(
          [
            `Integration writer owner=${shard.owner}. workdir=${workdir}.`,
            `Read ${methodRoot}/references/generate.md, the Spec, page assignments, and source-write checkpoint ${sourceWriteCheckpoint.checkpointPath} (${sourceWriteCheckpoint.checkpointDigest}).`,
            `JIT-read only declared domain handoffs/pages required for your pages: ${JSON.stringify(shard.pagePaths)}.`,
            writeLanguage,
            writeMultiSource,
            "You own only integration pages such as overview, repository/surface map, terminology, navigation, and cross-source flows. Do not edit any domain page.",
            "Cross-source synthesis must retain stage-level local citations into the frozen source trees.",
            `Write an integration handoff proposal to analysis/handoffs/write/integration-${id}.json with inputCheckpointDigests exactly [${sourceWriteCheckpoint.checkpointDigest}]. Return only the bounded handoff envelope.`,
          ].filter(Boolean).join("\n"),
          { label: `write:integration:${id}`, schema: ENVELOPE },
        );
      }),
    );
    writeLedger.push(
      ...wave.map((shard, index) => ({
        id: `integration:${shard.owner}`,
        owner: shard.owner,
        status: results[index]?.status ?? "failed",
        proposalPath: results[index]?.proposalPath ?? `analysis/handoffs/write/integration-${safeId(shard.owner)}.json`,
        summary: results[index]?.summary ?? "writer returned no envelope",
      })),
    );
  }
  if (writeLedger.some((entry) => entry.status !== "ok")) {
    return { runId, workdir, writeLedger, stopped: "one or more integration owners failed" };
  }

  const writeProposal = await agent(
    [
      `Write reducer. workdir=${workdir}. JIT-read only declared writer handoffs: ${JSON.stringify(conciseLedger(writeLedger))}.`,
      `Verify ownership and candidate path completeness against page assignments. Write analysis/handoffs/write.json with inputCheckpointDigests exactly [${sourceWriteCheckpoint.checkpointDigest}].`,
      "Return only the bounded handoff envelope.",
    ].join("\n"),
    { label: "reduce-write", schema: ENVELOPE },
  );
  if (writeProposal?.status !== "ok") return { runId, workdir, writeLedger, writeProposal, stopped: "write reduction failed" };
  const writeCheckpoint = await runCheckpoint({
    agent,
    workdir,
    phaseName: "write",
    proposalPath: writeProposal.proposalPath,
    label: "checkpoint-write",
  });
  if (writeCheckpoint?.status !== "ok") return { runId, workdir, writeCheckpoint, stopped: "write checkpoint failed" };

  let previousReview = null;
  let verificationInputDigest = writeCheckpoint.checkpointDigest;
  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
    phase("Verify");
    const pageReviews = [];
    const pageTargets = assignmentState.shards.flatMap((shard) => shard.pagePaths.map((pagePath) => ({ owner: shard.owner, pagePath })));
    for (const wave of waves(pageTargets)) {
      const results = await parallel(
        wave.map((target) => () => {
          const id = safeId(`${target.owner}-${target.pagePath}`);
          return agent(
            [
              `Citation reviewer for ${target.pagePath}, owner=${target.owner}. workdir=${workdir}.`,
              `Read ${methodRoot}/references/review.md, the assigned Spec entry, page assignments, frozen sources, candidate page, and predecessor checkpoint digest ${verificationInputDigest}.`,
              writeLanguage,
              "Try to refute every source-grounded claim. An unverified claim is a finding only when the page presents it as verified evidence.",
              `Write full findings to analysis/receipts/review/page-${id}-round-${round}.json and a handoff proposal to analysis/handoffs/review/page-${id}-round-${round}.json with inputCheckpointDigests exactly [${verificationInputDigest}].`,
              "Do not edit candidate pages. Return only the bounded handoff envelope.",
            ].join("\n"),
            { label: `review:page:${round}:${id}`, schema: ENVELOPE },
          );
        }),
      );
      pageReviews.push(
        ...wave.map((target, index) => ({
          id: `page:${target.pagePath}`,
          owner: target.owner,
          status: results[index]?.status ?? "failed",
          proposalPath: results[index]?.proposalPath ?? `analysis/handoffs/review/page-${safeId(`${target.owner}-${target.pagePath}`)}-round-${round}.json`,
          summary: results[index]?.summary ?? "page reviewer returned no envelope",
        })),
      );
    }
    const globalLenses = ["coverage-completeness", "information-architecture", "cross-source-contract"];
    const globalResults = await parallel(
      globalLenses.map((lens) => () =>
        agent(
          [
            `Global reviewer (${lens}). workdir=${workdir}. Read ${methodRoot}/references/review.md.`,
            `Inspect candidate, Spec, assignments, and predecessor checkpoint digest ${verificationInputDigest}.`,
            writeLanguage,
            writeMultiSource,
            "Use refute-by-default: report only defects with concrete evidence. Verify ownership, coverage, navigation, source citation locality, and cross-source contracts.",
            `Write findings to analysis/receipts/review/${lens}-round-${round}.json and a proposal to analysis/handoffs/review/${lens}-round-${round}.json with inputCheckpointDigests exactly [${verificationInputDigest}].`,
            "Do not edit candidate pages. Return only the bounded handoff envelope.",
          ].filter(Boolean).join("\n"),
          { label: `review:${lens}:${round}`, schema: ENVELOPE },
        ),
      ),
    );
    const reviewLedger = [
      ...pageReviews,
      ...globalLenses.map((lens, index) => ({
        id: lens,
        owner: "review",
        status: globalResults[index]?.status ?? "failed",
        proposalPath: globalResults[index]?.proposalPath ?? `analysis/handoffs/review/${lens}-round-${round}.json`,
        summary: globalResults[index]?.summary ?? "global reviewer returned no envelope",
      })),
    ];

    finalReview = await agent(
      [
        `Defect reducer, round ${round}. workdir=${workdir}.`,
        `JIT-read only review handoffs/receipts in this ledger: ${JSON.stringify(conciseLedger(reviewLedger))}.`,
        "Write analysis/defects.json conforming to schemas/defects.schema.json version 2.",
        "Every defect must have pagePath, owner, severity, category, evidence, repairSuggestion, and stable fingerprint. clean=true only when defects is empty.",
        "repairTargets may include only owners with blocking or major defects, using their assigned page paths.",
        `Write analysis/handoffs/review-${round}.json with inputCheckpointDigests exactly [${verificationInputDigest}]. Return the bounded review envelope.`,
      ].join("\n"),
      { label: `reduce-defects:${round}`, schema: REVIEW },
    );
    if (finalReview?.status !== "ok") return { runId, workdir, reviewLedger, finalReview, stopped: "defect reduction failed" };
    const reviewCheckpoint = await runCheckpoint({
      agent,
      workdir,
      phaseName: `review-${round}`,
      proposalPath: finalReview.proposalPath,
      label: `checkpoint-review:${round}`,
    });
    if (reviewCheckpoint?.status !== "ok") return { runId, workdir, finalReview, reviewCheckpoint, stopped: "review checkpoint failed" };
    finalReviewCheckpoint = reviewCheckpoint;
    if (finalReview.clean) break;

    const progressed =
      previousReview === null ||
      finalReview.blockingCount < previousReview.blockingCount ||
      finalReview.majorCount < previousReview.majorCount ||
      finalReview.defectFingerprint !== previousReview.defectFingerprint;
    if (!progressed || round === MAX_REPAIR_ROUNDS) {
      const blocked = await agent(
        [
          `Proof-or-stop recorder. workdir=${workdir}.`,
          `The repair loop stopped after round ${round}: ${!progressed ? "defect fingerprint/counts made no progress" : "repair budget exhausted"}.`,
          `Read ${workdir}/analysis/defects.json and write a blocked handoff proposal to analysis/handoffs/blocked-review-${round}.json with inputCheckpointDigests exactly [${reviewCheckpoint.checkpointDigest}].`,
          "Set proposal status to blocked. Declare unresolved defects as artifacts, retain owner/page paths, and explain why no additional autonomous repair is justified.",
          "Return only the bounded handoff envelope.",
        ].join("\n"),
        { label: `record-blocked:${round}`, schema: ENVELOPE },
      );
      const blockedCheckpoint =
        blocked?.status === "ok"
          ? await runCheckpoint({
              agent,
              workdir,
              phaseName: `blocked-${round}`,
              proposalPath: blocked.proposalPath,
              label: `checkpoint-blocked:${round}`,
            })
          : null;
      return {
        runId,
        workdir,
        review: finalReview,
        blocked,
        blockedCheckpoint,
        stopped: !progressed ? "repair loop made no measurable progress" : "repair loop budget exhausted",
      };
    }

    phase("Repair");
    const repairs = [];
    for (const wave of waves(finalReview.repairTargets)) {
      const results = await parallel(
        wave.map((target) => () => {
          const id = safeId(target.owner);
          return agent(
            [
              `Repair owner=${target.owner}. workdir=${workdir}.`,
              `Read ${methodRoot}/references/generate.md, analysis/defects.json, the assigned Spec entries, page assignments, and review checkpoint ${reviewCheckpoint.checkpointDigest}.`,
              writeLanguage,
              `You may modify only these candidate pages: ${JSON.stringify(target.pagePaths)}. Do not alter other owners' pages, the Spec, assignments, indexes, or logs.`,
              "Fix only blocking/major defects with source-grounded edits. Preserve valid local citations and ownership boundaries.",
              `Write a repair handoff proposal to analysis/handoffs/repair/${id}-round-${round}.json with inputCheckpointDigests exactly [${reviewCheckpoint.checkpointDigest}]. Return only the bounded handoff envelope.`,
            ].join("\n"),
            { label: `repair:${round}:${id}`, schema: ENVELOPE },
          );
        }),
      );
      repairs.push(
        ...wave.map((target, index) => ({
          id: `repair:${target.owner}`,
          owner: target.owner,
          status: results[index]?.status ?? "failed",
          proposalPath: results[index]?.proposalPath ?? `analysis/handoffs/repair/${safeId(target.owner)}-round-${round}.json`,
          summary: results[index]?.summary ?? "repairer returned no envelope",
        })),
      );
    }
    if (repairs.some((entry) => entry.status !== "ok")) return { runId, workdir, finalReview, repairs, stopped: "one or more repairs failed" };
    const repairProposal = await agent(
      [
        `Repair reducer. workdir=${workdir}. JIT-read only repair handoffs: ${JSON.stringify(conciseLedger(repairs))}.`,
        `Write analysis/handoffs/repair-${round}.json with inputCheckpointDigests exactly [${reviewCheckpoint.checkpointDigest}].`,
        "Return only the bounded handoff envelope.",
      ].join("\n"),
      { label: `reduce-repair:${round}`, schema: ENVELOPE },
    );
    if (repairProposal?.status !== "ok") return { runId, workdir, repairProposal, stopped: "repair reduction failed" };
    const repairCheckpoint = await runCheckpoint({
      agent,
      workdir,
      phaseName: `repair-${round}`,
      proposalPath: repairProposal.proposalPath,
      label: `checkpoint-repair:${round}`,
    });
    if (repairCheckpoint?.status !== "ok") return { runId, workdir, repairCheckpoint, stopped: "repair checkpoint failed" };
    previousReview = finalReview;
    verificationInputDigest = repairCheckpoint.checkpointDigest;
  }
  }

  if (!finalReview?.clean) return { runId, workdir, review: finalReview, stopped: "candidate has unresolved defects" };

  phase("Validate");
  const validation = await agent(
    [
      `Validator. workdir=${workdir}. Read run policy for hostCli.`,
      `Run exactly: <hostCli.node> <hostCli.script> validate --run ${runId} --workspace <hostCli.workspaceRoot>, substituting hostCli values.`,
      `The deterministic validator must recheck the write checkpoint and final review checkpoint ${finalReviewCheckpoint?.checkpointDigest}, page ownership, coverage, local source links, indexes, and candidate digest.`,
      `Write command output to analysis/validation.json and a handoff proposal to analysis/handoffs/validate.json with inputCheckpointDigests exactly [${finalReviewCheckpoint?.checkpointDigest}].`,
      "The validate proposal MUST declare analysis/validation.json and analysis/candidate.manifest.json as artifacts, because the host validates both before publishing the terminal checkpoint.",
      "validate does not transition run state to sealed; the following authoritative validate checkpoint is the only sealing transition. Return status=ok only after the command succeeds, and return only the bounded handoff envelope.",
    ].join("\n"),
    { label: "validate-and-seal", schema: ENVELOPE },
  );
  if (validation?.status !== "ok") return { runId, workdir, validation, stopped: "validation failed" };
  const validationCheckpoint = await runCheckpoint({
    agent,
    workdir,
    phaseName: "validate",
    proposalPath: validation.proposalPath,
    label: "checkpoint-validate",
  });
  if (validationCheckpoint?.status !== "ok") return { runId, workdir, validation, validationCheckpoint, stopped: "validation checkpoint failed" };

  log(`wiki sealed for ${runId}`);
  return { runId, workdir, workspaceRoot, mode: input.mode, review: finalReview, validation, validationCheckpoint, next: "sealed" };
})();
