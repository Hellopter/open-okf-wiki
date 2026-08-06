/**
 * wiki - single-command, checkpointed repository wiki production workflow.
 *
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 * The host CLI owns run state and checkpoint authority. Agents own only
 * run-local data-plane artifacts and compact progress summaries.
 */

export const meta = {
  name: "wiki",
  description: "Produce a source-grounded Wiki through checkpointed survey, planning, writing, verification, repair, and sealing",
  phases: [
    { title: "Bootstrap", detail: "prepare or resume a checkpointed run" },
    { title: "Survey", detail: "fan out full inventory coverage with fair policy-limited waves" },
    { title: "Plan", detail: "assign owned pages and gate the plan" },
    { title: "Write", detail: "write domain shards, then integration shards" },
    { title: "Verify", detail: "independently refute unsupported claims" },
    { title: "Repair", detail: "route defects back to page owners" },
    { title: "Validate", detail: "mechanically validate and seal" },
  ],
};

const LIMITS = {
  type: "object",
  additionalProperties: false,
  required: ["batchConcurrency", "perSourceConcurrency", "maxCoveragePasses", "maxRepairRounds"],
  properties: {
    batchConcurrency: { type: "number" },
    perSourceConcurrency: { type: "number" },
    maxCoveragePasses: { type: "number" },
    maxRepairRounds: { type: "number" },
  },
};

const ENVELOPE = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed", "skipped"] },
    summary: { type: "string", maxLength: 1500 },
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
    mode: { type: "string", enum: ["auto", "plan", "write", "restart", "retry-plan", "retry-write"] },
    startAt: {
      type: "string",
      enum: ["survey", "plan", "gate", "ready", "write-sources", "write", "review-1", "review-2", "review-3", "review-4", "repair-1", "repair-2", "repair-3", "repair-4", "validate", "sealed"],
    },
    inputCheckpointDigest: { type: ["string", "null"] },
    summary: { type: "string", maxLength: 6000 },
  },
};

const INVENTORY = {
  type: "object",
  additionalProperties: false,
  required: ["units", "tier", "sourceCount", "wikiLanguage", "limits"],
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
    limits: LIMITS,
  },
};

const RESUMED_DISCOVERY = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checkpointPath", "checkpointDigest", "wikiLanguage", "sourceCount", "tier", "limits", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    checkpointPath: { type: "string", minLength: 1 },
    checkpointDigest: { type: "string", minLength: 16 },
    wikiLanguage: { type: "string", enum: ["en", "zh"] },
    sourceCount: { type: "number" },
    tier: { type: "string" },
    focus: { type: ["string", "null"] },
    limits: LIMITS,
    summary: { type: "string", maxLength: 6000 },
  },
};

const RESUMED_REVIEW = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checkpointDigest", "clean", "blockingCount", "majorCount", "defectFingerprint", "repairTargets", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    checkpointDigest: { type: "string", minLength: 16 },
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
    summary: { type: "string", maxLength: 6000 },
  },
};

const SURVEY_MERGE = {
  type: "object",
  additionalProperties: false,
  required: ["status", "pass", "artifactsPath", "missingUnitIds", "retryUnitIds", "needsDomainLabels"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    pass: { type: "integer", minimum: 1 },
    artifactsPath: { type: "string", minLength: 1 },
    missingUnitIds: { type: "array", items: { type: "string", minLength: 1 } },
    retryUnitIds: { type: "array", items: { type: "string", minLength: 1 } },
    selectedUnitIds: { type: "array", items: { type: "string", minLength: 1 } },
    invalidReceiptPaths: { type: "array", items: { type: "string", minLength: 1 } },
    needsDomainLabels: { type: "boolean" },
    domains: { type: "integer", minimum: 0 },
    flows: { type: "integer", minimum: 0 },
    summary: { type: "string", maxLength: 1500 },
  },
};

const ASSIGNMENTS = {
  type: "object",
  additionalProperties: false,
  required: ["wikiLanguage", "sourceCount", "tier", "limits", "shards"],
  properties: {
    wikiLanguage: { type: "string", enum: ["en", "zh"] },
    sourceCount: { type: "number" },
    tier: { type: "string" },
    limits: LIMITS,
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
  required: ["status", "summary", "clean", "blockingCount", "majorCount", "defectFingerprint", "repairTargets"],
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
  const validModes = new Set(["auto", "plan", "write", "restart", "retry-plan", "retry-write"]);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mode = validModes.has(value.mode) ? value.mode : "auto";
    const focus = typeof value.focus === "string" && value.focus.trim() ? value.focus.trim() : undefined;
    return { mode, focus };
  }
  const text = typeof value === "string" ? value.trim() : "";
  const match = text.match(/^(--plan|--write|--restart|--retry\s+plan|--retry\s+write)(?:\s+|$)([\s\S]*)$/);
  if (!match) return { mode: "auto", focus: text || undefined };
  const mode = {
    "--plan": "plan",
    "--write": "write",
    "--restart": "restart",
    "--retry plan": "retry-plan",
    "--retry write": "retry-write",
  }[match[1].replace(/\s+/g, " ")];
  const focus = match[2].trim();
  return { mode, focus: focus || undefined };
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 80) || "item";
}

function surveyFileId(value) {
  return encodeURIComponent(String(value));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeLimits(raw, sourceCount) {
  const multi = Number(sourceCount) >= 2;
  const defaults = {
    batchConcurrency: multi ? 3 : 4,
    perSourceConcurrency: 2,
    maxCoveragePasses: 2,
    maxRepairRounds: 2,
  };
  const input = raw && typeof raw === "object" ? raw : {};
  const batchConcurrency = clampInt(input.batchConcurrency, 1, 8, defaults.batchConcurrency);
  const perSourceConcurrency = clampInt(
    input.perSourceConcurrency,
    1,
    batchConcurrency,
    Math.min(defaults.perSourceConcurrency, batchConcurrency),
  );
  const maxCoveragePasses = clampInt(input.maxCoveragePasses, 1, 4, defaults.maxCoveragePasses);
  const maxRepairRounds = clampInt(input.maxRepairRounds, 1, 4, defaults.maxRepairRounds);
  return { batchConcurrency, perSourceConcurrency, maxCoveragePasses, maxRepairRounds };
}

function scheduleWaves(items, { concurrency, perSourceConcurrency }, sourceKey) {
  const list = Array.isArray(items) ? items : [];
  const conc = clampInt(concurrency, 1, 8, 4);
  const perSrc = clampInt(perSourceConcurrency, 1, conc, Math.min(2, conc));
  const keyFn = typeof sourceKey === "function" ? sourceKey : (item) => item?.sourceId ?? item?.owner ?? "_";
  const queues = new Map();
  const sourceOrder = [];
  for (const item of list) {
    const sid = String(keyFn(item) || "_");
    if (!queues.has(sid)) {
      queues.set(sid, []);
      sourceOrder.push(sid);
    }
    queues.get(sid).push(item);
  }
  const wavesOut = [];
  const nextIndex = Object.fromEntries(sourceOrder.map((s) => [s, 0]));
  while (sourceOrder.some((s) => nextIndex[s] < queues.get(s).length)) {
    const wave = [];
    const taken = Object.fromEntries(sourceOrder.map((s) => [s, 0]));
    let progressed = true;
    while (wave.length < conc && progressed) {
      progressed = false;
      for (const sid of sourceOrder) {
        if (wave.length >= conc) break;
        if (taken[sid] >= perSrc) continue;
        const q = queues.get(sid);
        const i = nextIndex[sid];
        if (i >= q.length) continue;
        wave.push(q[i]);
        nextIndex[sid] = i + 1;
        taken[sid] += 1;
        progressed = true;
      }
    }
    if (!wave.length) break;
    wavesOut.push(wave);
  }
  return wavesOut;
}

function selectUnitsByIds(units, ids) {
  const want = new Set([...ids].map(String));
  return (units || []).filter((unit) => want.has(String(unit.id)));
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
  if (!(sourceCount >= 2 && tier === "L3")) return "";
  return [
    "MULTI-SOURCE DEEP ANALYSIS REQUIRED.",
    "Keep each source substantively represented with grounded purpose, public surfaces, key modules, and contracts.",
    "Plan repository/surface mapping and a cited cross-source flow unless a structured cancellation explains why none exists.",
    "Do not replace architecture evidence with a thin overview or an uncited synthesis.",
  ].join(" ");
}

function conciseLedger(entries) {
  return entries.map(({ id, owner, status, receiptPath, summary }) => ({ id, owner, status, receiptPath, summary }));
}

const HOST = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checkpointPath", "checkpointDigest"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    checkpointPath: { type: "string" },
    checkpointDigest: { type: "string" },
    summary: { type: "string", maxLength: 6000 },
  },
};

function dataPlaneOnlyRule() {
  return [
    "Write data-plane artifacts only (receipts, maps, specs, pages, defects, validation outputs).",
    "When listing artifacts for the host, write analysis/receipts/*-artifacts.json as a JSON array of {id,type,path,coverageUnitIds?}.",
    "The host CLI computes artifact digests and publishes the phase checkpoint.",
  ].join(" ");
}

function hostCliPreamble(workdir) {
  return [
    `Read ${workdir}/inputs/run-policy.json for hostCli.{node,script,workspaceRoot}.`,
    "Substitute hostCli values into the exact command. Return status=ok only for exit code 0 and parse JSON stdout.",
  ].join(" ");
}

function buildPublishArgv({ phase, artifactsJson }) {
  if (!artifactsJson) throw new Error(`publish ${phase} requires an artifactsJson path`);
  return [
    "<hostCli.node> <hostCli.script> publish",
    "--workspace <hostCli.workspaceRoot>",
    `--phase ${phase}`,
    `--artifacts-json ${artifactsJson}`,
  ];
}

async function runHostPublish(agent, opts) {
  const { workdir, phase, artifactsJson, label } = opts;
  const argv = buildPublishArgv({ phase, artifactsJson }).join(" ");
  return agent(
    [
      `Host phase publish. workdir=${workdir}.`,
      hostCliPreamble(workdir),
      `Run exactly: ${argv}`,
      "Return status=ok, checkpointPath, and checkpointDigest from JSON stdout.",
    ].join("\n"),
    { label: label || `publish:${phase}`, schema: HOST },
  );
}

async function runSurveyMerge(agent, { workdir, runId, pass, labelsPath }) {
  const labels = labelsPath ? ` --labels ${labelsPath}` : "";
  return agent(
    [
      `Survey merge. workdir=${workdir}.`,
      hostCliPreamble(workdir),
      `Run exactly: <hostCli.node> <hostCli.script> survey-merge --workspace <hostCli.workspaceRoot> --run ${runId} --pass ${pass}${labels}, substituting hostCli values.`,
      "The host writes the Discovery Map and artifact list. Return the parsed command JSON fields exactly.",
    ].join("\n"),
    { label: `survey-merge:${pass}${labelsPath ? ":labels" : ""}`, schema: SURVEY_MERGE },
  );
}

return await (async () => {
  const input = normalizeArgs(args);
  phase("Bootstrap");
  const bootstrap = await agent(
    [
      "Bootstrap a Wiki v3 run. Read .wiki-agent/runtime.json in this workspace; it is the only host-command authority.",
      `Requested business input: ${JSON.stringify(input)}.`,
      "Invoke the runtime manifest's exact node/script with `prepare --mode <requested mode>`.",
      "Pass focus only as one safely quoted argument when it is present. Do not synthesize or accept runId/workdir input.",
      "prepare selects the unique next edge from verified checkpoints: survey, plan, gate, write-sources, write, review-N, repair-N, or validate.",
      "Return the prepare JSON fields exactly. Fail closed on an invalid checkpoint or frozen snapshot.",
    ].join("\n"),
    { label: "bootstrap-prepare", schema: BOOTSTRAP },
  );
  if (bootstrap?.status !== "ok") return { stopped: "prepare failed", input, bootstrap };

  const { runId, workdir, workspaceRoot } = bootstrap;
  if (!runId || !workdir || !workspaceRoot) return { stopped: "prepare returned incomplete run context", input, bootstrap };
  if (bootstrap.startAt === "sealed") return { runId, workdir, workspaceRoot, mode: input.mode, next: "sealed" };
  const methodRoot = `${workdir}/method`;
  const startsPlanning = ["survey", "plan"].includes(bootstrap.startAt);
  const canFinishPlan = ["survey", "plan", "gate"].includes(bootstrap.startAt);
  if (input.mode === "plan" && !canFinishPlan) {
    return { runId, workdir, workspaceRoot, mode: input.mode, stopped: "a gate-ready plan already exists", next: "/wiki --write" };
  }
  if (input.mode === "write" && startsPlanning) {
    return { runId, workdir, workspaceRoot, stopped: "--write requires an authoritative plan checkpoint and gate" };
  }

  let wikiLanguage = "en";
  let sourceCount = 1;
  let tier = "L0";
  let focusRule = "";
  let multiSource = "";
  let limits = normalizeLimits(undefined, 1);
  let discoveryCheckpoint = null;
  let planCheckpoint = null;
  let startAt = bootstrap.startAt;

  const applyContext = (context) => {
    wikiLanguage = context.wikiLanguage === "zh" ? "zh" : "en";
    sourceCount = Number.isFinite(context.sourceCount) ? context.sourceCount : 1;
    tier = typeof context.tier === "string" ? context.tier : "L0";
    limits = normalizeLimits(context.limits, sourceCount);
    focusRule = context.focus ? `Operator focus: ${context.focus}` : "";
    multiSource = multiSourceDirective(sourceCount, tier);
  };
  const hydrate = async (boundary) => {
    const context = await agent(
      [
        `Resume context for ${boundary}. workdir=${workdir}.`,
        `Read inputs/run-policy.json, inputs/inventory.json, and the verified current checkpoint bound to digest ${bootstrap.inputCheckpointDigest}.`,
        "Return policy controls, limits, and the verified checkpoint path/digest. Do not write artifacts or advance state.",
      ].join("\n"),
      { label: `hydrate:${boundary}`, schema: RESUMED_DISCOVERY },
    );
    if (context?.status !== "ok" || context.checkpointDigest !== bootstrap.inputCheckpointDigest) return null;
    applyContext(context);
    return context;
  };

  if (startsPlanning) {
    let inventory;
    if (startAt === "survey") {
      phase("Survey");
      inventory = await agent(
        [
          `Read ${workdir}/inputs/inventory.json and ${workdir}/inputs/run-policy.json.`,
          "Return coverage units from inventory.coverageUnits and policy controls needed for topology. Do not return source bodies.",
          "Each coverage unit must preserve id, kind, sourceId, path, and label when present.",
          "Return limits from run-policy.json limits and focus from run-policy.",
        ].join("\n"),
        { label: "load-inventory", schema: INVENTORY },
      );
      if (!inventory?.units?.length) return { runId, workdir, stopped: "inventory has no coverage units", inventory };
      applyContext(inventory);
      const surveyLanguage = languageDirective(wikiLanguage, "survey receipt summaries, purposes, and open questions");
      let pendingUnits = inventory.units;
      let lastSurveyPass = 1;
      let surveyMerge = null;
      for (let pass = 1; pass <= limits.maxCoveragePasses && pendingUnits.length; pass++) {
        for (const wave of scheduleWaves(
          pendingUnits,
          { concurrency: limits.batchConcurrency, perSourceConcurrency: limits.perSourceConcurrency },
          (unit) => unit.sourceId,
        )) {
          const results = await parallel(
            wave.map((unit) => () => {
              const id = safeId(unit.id);
              const receiptFile = surveyFileId(unit.id);
              const sourceMulti = unit.kind === "source" ? multiSource : "";
              return agent(
                [
                  `Surveyor for coverage unit ${JSON.stringify(unit)}. workdir=${workdir}.`,
                  `Read ${methodRoot}/references/survey-unit.md and ${workdir}/inputs/run-policy.json.`,
                  surveyLanguage,
                  sourceMulti,
                  focusRule,
                  `Read frozen evidence only under ${workdir}/sources/.`,
                  unit.kind === "surface"
                    ? `Surface unit: inspect only sources/${unit.sourceId}/${unit.path || ""}/.`
                    : "Source unit: index entry points, build topology, surfaces, and cross-surface contracts; list child surfaces in relatedCoverageUnitIds without deep-diving them.",
                  `Write one schema-shaped survey receipt under analysis/receipts/survey/${receiptFile}-pass-${pass}.json even when the unit is incomplete.`,
                  "Return status and a compact summary only. Do not write maps, artifact lists, or candidate pages.",
                ].filter(Boolean).join("\n"),
                { label: `survey:${pass}:${id}`, schema: ENVELOPE },
              );
            }),
          );
          if (results.some((result) => result?.status === "failed")) {
            log(`one or more surveyors reported failure in pass ${pass}; host merge will classify the on-disk receipts`);
          }
        }
        surveyMerge = await runSurveyMerge(agent, { workdir, runId, pass });
        if (surveyMerge?.status !== "ok") return { runId, workdir, surveyMerge, stopped: "survey merge failed" };
        lastSurveyPass = pass;
        pendingUnits = pass >= limits.maxCoveragePasses
          ? []
          : selectUnitsByIds(inventory.units, new Set((surveyMerge.retryUnitIds ?? []).map(String)));
      }
      if (!surveyMerge) return { runId, workdir, stopped: "survey produced no host merge" };
      if (surveyMerge.missingUnitIds?.length) {
        return { runId, workdir, surveyMerge, stopped: "survey coverage remains retryable or missing after its pass budget" };
      }
      if (surveyMerge.needsDomainLabels) {
        const labelsPath = `analysis/receipts/discovery-labels-pass-${lastSurveyPass}.json`;
        const labels = await agent(
          [
            `Discovery labels. workdir=${workdir}.`,
            "Read analysis/discovery-map.json only.",
            languageDirective(wikiLanguage, "domain and flow labels"),
            `Write ${labelsPath} as JSON {domains,flows}; each item has id, summary, coverageUnitIds, and flows may set crossSource.`,
            "Provide at least one domain. Do not edit the Discovery Map, receipts, or artifact list.",
            "Return status and a compact summary only.",
          ].join("\n"),
          { label: `discover-labels:${lastSurveyPass}`, schema: ENVELOPE },
        );
        if (labels?.status !== "ok") return { runId, workdir, labels, stopped: "discovery labels failed" };
        surveyMerge = await runSurveyMerge(agent, { workdir, runId, pass: lastSurveyPass, labelsPath });
        if (surveyMerge?.status !== "ok") return { runId, workdir, surveyMerge, stopped: "survey merge labels failed" };
      }
      discoveryCheckpoint = await runHostPublish(agent, {
        workdir,
        phase: "discover",
        artifactsJson: surveyMerge.artifactsPath,
        label: "publish:discover",
      });
      if (discoveryCheckpoint?.status !== "ok") return { runId, workdir, discoveryCheckpoint, stopped: "discovery checkpoint failed" };
    } else {
      const resumed = await hydrate("plan");
      if (!resumed) return { runId, workdir, stopped: "cannot resume plan without a valid discovery checkpoint" };
      discoveryCheckpoint = { checkpointDigest: bootstrap.inputCheckpointDigest };
    }

    phase("Plan");
    const plan = await agent(
      [
        `Planner. workdir=${workdir}. Read ${methodRoot}/references/plan.md in full.`,
        `Read analysis/discovery-map.json, inputs/inventory.json, inputs/run-policy.json, and the discover checkpoint ${discoveryCheckpoint.checkpointDigest}.`,
        languageDirective(wikiLanguage, "Spec titles, questions, labels, and prose"),
        multiSource,
        focusRule,
        "Write analysis/spec.json conforming to schemas/spec.schema.json version 2 and analysis/page-assignments.json.",
        dataPlaneOnlyRule(),
        "Write analysis/receipts/plan-artifacts.json as a JSON array of {id,type,path} for spec and page assignments.",
        "Every candidate page has one owner and one candidate path. Bind every required coverage unit or record a structured cancellation.",
        "Return status and a compact summary only. Do not write candidate pages.",
      ].filter(Boolean).join("\n"),
      { label: "plan-spec", schema: ENVELOPE },
    );
    if (plan?.status !== "ok") return { runId, workdir, plan, stopped: "plan generation failed" };
    planCheckpoint = await runHostPublish(agent, {
      workdir,
      phase: "plan",
      artifactsJson: "analysis/receipts/plan-artifacts.json",
      label: "publish:plan",
    });
    if (planCheckpoint?.status !== "ok") return { runId, workdir, planCheckpoint, stopped: "plan checkpoint failed" };
    startAt = "gate";
  } else {
    const resumed = await hydrate(startAt);
    if (!resumed) return { runId, workdir, stopped: `cannot hydrate ${startAt}` };
    planCheckpoint = { checkpointDigest: bootstrap.inputCheckpointDigest };
  }

  if (startAt === "gate") {
    const gate = await agent(
      [
        `Plan gate. Read ${workdir}/inputs/run-policy.json for hostCli.`,
        `Run exactly: <hostCli.node> <hostCli.script> gate plan --run ${runId} --workspace <hostCli.workspaceRoot>, substituting hostCli values.`,
        `The receipt must bind the plan checkpoint digest ${planCheckpoint?.checkpointDigest ?? bootstrap.inputCheckpointDigest}.`,
        `Write command output to ${workdir}/analysis/receipts/gate-plan.json.`,
        "Return status=ok only after the deterministic gate succeeds. It must not change the active checkpoint pointer.",
      ].join("\n"),
      { label: "gate-plan", schema: ENVELOPE },
    );
    if (gate?.status !== "ok") return { runId, workdir, gate, stopped: "plan gate failed" };
    if (input.mode === "plan") {
      log(`plan checkpointed for ${runId}; wait for explicit /wiki --write`);
      return { runId, workdir, workspaceRoot, mode: input.mode, planCheckpoint, next: "/wiki --write" };
    }
    startAt = "write-sources";
  }

  if (startAt === "ready") startAt = "write-sources";
  const reviewStart = /^review-(\d+)$/.exec(startAt);
  const repairStart = /^repair-(\d+)$/.exec(startAt);
  const needsAssignments = startAt !== "validate";
  let assignmentState = null;
  let writeLanguage = languageDirective(wikiLanguage, "candidate page titles, headings, and prose");
  let writeMultiSource = multiSourceDirective(sourceCount, tier);
  if (needsAssignments) {
    assignmentState = await agent(
      [
        `Read ${workdir}/analysis/spec.json, ${workdir}/analysis/page-assignments.json, and ${workdir}/inputs/run-policy.json.`,
        "Validate unique page ownership and return compact owner shards with assigned page paths and declared dependencies. Return limits for fan-out budgeting.",
      ].join("\n"),
      { label: "load-page-assignments", schema: ASSIGNMENTS },
    );
    if (!assignmentState?.shards?.length) return { runId, workdir, assignmentState, stopped: "no valid page assignments" };
    wikiLanguage = assignmentState.wikiLanguage === "zh" ? "zh" : wikiLanguage;
    sourceCount = Number.isFinite(assignmentState.sourceCount) ? assignmentState.sourceCount : sourceCount;
    tier = typeof assignmentState.tier === "string" ? assignmentState.tier : tier;
    limits = normalizeLimits(assignmentState.limits ?? limits, sourceCount);
    writeLanguage = languageDirective(wikiLanguage, "candidate page titles, headings, and prose");
    writeMultiSource = multiSourceDirective(sourceCount, tier);
  }

  let writeCheckpoint = null;
  let sourceWriteCheckpoint = null;
  if (["write-sources", "write"].includes(startAt)) {
    phase("Write");
    const preflight = await agent(
      [
        `Write preflight. workdir=${workdir}. Read run policy and plan artifacts.`,
        `Run exactly: <hostCli.node> <hostCli.script> gate check --run ${runId} --workspace <hostCli.workspaceRoot>, substituting hostCli values.`,
        "Write analysis/receipts/preflight.json and return status only. Do not advance state.",
      ].join("\n"),
      { label: "preflight-write", schema: ENVELOPE },
    );
    if (preflight?.status !== "ok") return { runId, workdir, preflight, stopped: "write preflight failed" };
  }

  if (startAt === "write-sources") {
    const domainShards = assignmentState.shards.filter((shard) => shard.role === "domain");
    const domainLedger = [];
    for (const wave of scheduleWaves(
      domainShards,
      { concurrency: limits.batchConcurrency, perSourceConcurrency: limits.perSourceConcurrency },
      (shard) => shard.sourceIds?.[0] ?? shard.owner,
    )) {
      const results = await parallel(
        wave.map((shard) => () => agent(
          [
            `Domain writer owner=${shard.owner}. workdir=${workdir}.`,
            `Read ${methodRoot}/references/generate.md, run policy, Spec, and declared source evidence.`,
            writeLanguage,
            writeMultiSource,
            `Your exclusive candidate pages: ${JSON.stringify(shard.pagePaths)}. Write no other candidate page, index, navigation, or log.`,
            `Re-open frozen evidence under ${workdir}/sources/ for every source claim.`,
            "Return status and a compact summary only.",
          ].filter(Boolean).join("\n"),
          { label: `write:domain:${safeId(shard.owner)}`, schema: ENVELOPE },
        )),
      );
      domainLedger.push(...wave.map((shard, index) => ({
        id: `domain:${shard.owner}`,
        owner: shard.owner,
        status: results[index]?.status ?? "failed",
        receiptPath: `candidate/${shard.pagePaths?.[0] ?? ""}`,
        summary: results[index]?.summary ?? "writer returned no summary",
      })));
    }
    if (domainLedger.some((entry) => entry.status !== "ok")) return { runId, workdir, domainLedger, stopped: "one or more domain owners failed" };
    const reduced = await agent(
      [
        `Write-source reducer. workdir=${workdir}. Inspect only these completed domain outputs: ${JSON.stringify(conciseLedger(domainLedger))}.`,
        "Verify domain ownership and write analysis/receipts/write-sources-artifacts.json as a JSON array of {id,type,path}.",
        "Return status and a compact summary only.",
      ].join("\n"),
      { label: "reduce-write-sources", schema: ENVELOPE },
    );
    if (reduced?.status !== "ok") return { runId, workdir, reduced, stopped: "domain write reduction failed" };
    sourceWriteCheckpoint = await runHostPublish(agent, {
      workdir,
      phase: "write-sources",
      artifactsJson: "analysis/receipts/write-sources-artifacts.json",
      label: "publish:write-sources",
    });
    if (sourceWriteCheckpoint?.status !== "ok") return { runId, workdir, sourceWriteCheckpoint, stopped: "domain write checkpoint failed" };
    startAt = "write";
  }

  if (startAt === "write") {
    const integrationShards = assignmentState.shards.filter((shard) => shard.role === "integration");
    const integrationLedger = [];
    for (const wave of scheduleWaves(
      integrationShards,
      { concurrency: limits.batchConcurrency, perSourceConcurrency: limits.perSourceConcurrency },
      (shard) => shard.owner,
    )) {
      const results = await parallel(
        wave.map((shard) => () => agent(
          [
            `Integration writer owner=${shard.owner}. workdir=${workdir}.`,
            `Read ${methodRoot}/references/generate.md, Spec, page assignments, and the published write-sources checkpoint ${sourceWriteCheckpoint?.checkpointDigest ?? bootstrap.inputCheckpointDigest}.`,
            writeLanguage,
            writeMultiSource,
            `You own only these integration pages: ${JSON.stringify(shard.pagePaths)}.`,
            "Cross-source synthesis must retain local citations into frozen source trees. Return status and a compact summary only.",
          ].filter(Boolean).join("\n"),
          { label: `write:integration:${safeId(shard.owner)}`, schema: ENVELOPE },
        )),
      );
      integrationLedger.push(...wave.map((shard, index) => ({
        id: `integration:${shard.owner}`,
        owner: shard.owner,
        status: results[index]?.status ?? "failed",
        receiptPath: `candidate/${shard.pagePaths?.[0] ?? ""}`,
        summary: results[index]?.summary ?? "writer returned no summary",
      })));
    }
    if (integrationLedger.some((entry) => entry.status !== "ok")) return { runId, workdir, integrationLedger, stopped: "one or more integration owners failed" };
    const reduced = await agent(
      [
        `Write reducer. workdir=${workdir}. Inspect only these integration outputs: ${JSON.stringify(conciseLedger(integrationLedger))}.`,
        "Verify candidate completeness and write analysis/receipts/write-artifacts.json as a JSON array of {id,type,path}.",
        "Return status and a compact summary only.",
      ].join("\n"),
      { label: "reduce-write", schema: ENVELOPE },
    );
    if (reduced?.status !== "ok") return { runId, workdir, reduced, stopped: "write reduction failed" };
    writeCheckpoint = await runHostPublish(agent, {
      workdir,
      phase: "write",
      artifactsJson: "analysis/receipts/write-artifacts.json",
      label: "publish:write",
    });
    if (writeCheckpoint?.status !== "ok") return { runId, workdir, writeCheckpoint, stopped: "write checkpoint failed" };
    startAt = "review-1";
  }

  let finalReview = null;
  let finalReviewCheckpoint = null;
  if (startAt === "validate") {
    finalReview = { clean: true, resumed: true };
    finalReviewCheckpoint = { checkpointDigest: bootstrap.inputCheckpointDigest };
  } else {
    let round = reviewStart ? Number(reviewStart[1]) : repairStart ? Number(repairStart[1]) : 1;
    let repairResume = repairStart ? Number(repairStart[1]) : null;
    let previousReview = null;
    let verificationInputDigest = writeCheckpoint?.checkpointDigest ?? bootstrap.inputCheckpointDigest;
    if (typeof verificationInputDigest !== "string" || !verificationInputDigest) {
      return { runId, workdir, stopped: "review has no authoritative predecessor checkpoint" };
    }
    for (; round <= limits.maxRepairRounds; round++) {
      let reviewCheckpoint;
      if (repairResume === round) {
        const resumedReview = await agent(
          [
            `Resume repair ${round}. workdir=${workdir}.`,
            `Read analysis/defects.json and verify the current review-${round} checkpoint ${bootstrap.inputCheckpointDigest}.`,
            "Return the stored defect counts, fingerprint, clean flag, and repair targets without editing artifacts.",
          ].join("\n"),
          { label: `hydrate:review-${round}`, schema: RESUMED_REVIEW },
        );
        if (
          resumedReview?.status !== "ok" ||
          resumedReview.checkpointDigest !== bootstrap.inputCheckpointDigest ||
          resumedReview.clean
        ) {
          return { runId, workdir, resumedReview, stopped: "cannot resume repair from defects" };
        }
        finalReview = resumedReview;
        reviewCheckpoint = { checkpointDigest: bootstrap.inputCheckpointDigest };
        finalReviewCheckpoint = reviewCheckpoint;
        repairResume = null;
      } else {
        phase("Verify");
        const targets = assignmentState.shards.flatMap((shard) => shard.pagePaths.map((pagePath) => ({ owner: shard.owner, pagePath })));
        const pageReviews = [];
        for (const wave of scheduleWaves(
          targets,
          { concurrency: limits.batchConcurrency, perSourceConcurrency: limits.perSourceConcurrency },
          (target) => target.owner,
        )) {
          const results = await parallel(wave.map((target) => () => agent(
            [
              `Citation reviewer for ${target.pagePath}, owner=${target.owner}. workdir=${workdir}.`,
              `Read ${methodRoot}/references/review.md, assigned Spec entry, candidate page, frozen sources, and predecessor checkpoint ${verificationInputDigest}.`,
              writeLanguage,
              `Write findings to analysis/receipts/review/page-${safeId(`${target.owner}-${target.pagePath}`)}-round-${round}.json. Do not edit candidate pages.`,
              "Return status and a compact summary only.",
            ].join("\n"),
            { label: `review:page:${round}:${safeId(`${target.owner}-${target.pagePath}`)}`, schema: ENVELOPE },
          )));
          pageReviews.push(...wave.map((target, index) => ({
            id: `page:${target.pagePath}`,
            owner: target.owner,
            status: results[index]?.status ?? "failed",
            receiptPath: `analysis/receipts/review/page-${safeId(`${target.owner}-${target.pagePath}`)}-round-${round}.json`,
            summary: results[index]?.summary ?? "reviewer returned no summary",
          })));
        }
        const lenses = ["coverage-completeness", "information-architecture", "cross-source-contract"];
        const global = await parallel(lenses.map((lens) => () => agent(
          [
            `Global reviewer (${lens}). workdir=${workdir}. Read ${methodRoot}/references/review.md.`,
            `Inspect candidate, Spec, assignments, and predecessor checkpoint ${verificationInputDigest}.`,
            writeLanguage,
            writeMultiSource,
            `Write findings to analysis/receipts/review/${lens}-round-${round}.json. Do not edit candidate pages.`,
            "Return status and a compact summary only.",
          ].filter(Boolean).join("\n"),
          { label: `review:${lens}:${round}`, schema: ENVELOPE },
        )));
        const reviewLedger = [
          ...pageReviews,
          ...lenses.map((lens, index) => ({
            id: lens,
            owner: "review",
            status: global[index]?.status ?? "failed",
            receiptPath: `analysis/receipts/review/${lens}-round-${round}.json`,
            summary: global[index]?.summary ?? "reviewer returned no summary",
          })),
        ];
        finalReview = await agent(
          [
            `Defect reducer, round ${round}. workdir=${workdir}.`,
            `Read only these review receipts: ${JSON.stringify(conciseLedger(reviewLedger))}.`,
            "Write analysis/defects.json conforming to schemas/defects.schema.json version 2 and analysis/receipts/review-artifacts-round-${round}.json as {id,type,path}.",
            "Every defect has pagePath, owner, severity, category, evidence, repairSuggestion, and stable fingerprint. clean=true only when defects is empty.",
            "Return status, clean, counts, fingerprint, and repair targets.",
          ].join("\n"),
          { label: `reduce-defects:${round}`, schema: REVIEW },
        );
        if (finalReview?.status !== "ok") return { runId, workdir, finalReview, stopped: "defect reduction failed" };
        reviewCheckpoint = await runHostPublish(agent, {
          workdir,
          phase: `review-${round}`,
          artifactsJson: `analysis/receipts/review-artifacts-round-${round}.json`,
          label: `publish:review-${round}`,
        });
        if (reviewCheckpoint?.status !== "ok") return { runId, workdir, finalReview, reviewCheckpoint, stopped: "review checkpoint failed" };
        finalReviewCheckpoint = reviewCheckpoint;
      }
      if (finalReview.clean) break;
      const progressed = previousReview === null ||
        finalReview.blockingCount < previousReview.blockingCount ||
        finalReview.majorCount < previousReview.majorCount ||
        finalReview.defectFingerprint !== previousReview.defectFingerprint;
      if (!progressed || round === limits.maxRepairRounds) {
        const blocked = await agent(
          [
            `Proof-or-stop recorder. workdir=${workdir}.`,
            `The repair loop stopped after round ${round}: ${!progressed ? "defect fingerprint/counts made no progress" : "repair budget exhausted"}.`,
            "Read analysis/defects.json and record a concise local note. Do not change checkpoint state.",
          ].join("\n"),
          { label: `record-blocked:${round}`, schema: ENVELOPE },
        );
        return {
          runId,
          workdir,
          review: finalReview,
          blocked,
          stopped: !progressed ? "repair loop made no measurable progress" : "repair loop budget exhausted",
        };
      }
      phase("Repair");
      const repairs = [];
      for (const wave of scheduleWaves(
        finalReview.repairTargets,
        { concurrency: limits.batchConcurrency, perSourceConcurrency: limits.perSourceConcurrency },
        (target) => target.owner,
      )) {
        const results = await parallel(wave.map((target) => () => agent(
          [
            `Repair owner=${target.owner}. workdir=${workdir}.`,
            `Read ${methodRoot}/references/generate.md, analysis/defects.json, assigned Spec entries, page assignments, and review checkpoint ${reviewCheckpoint.checkpointDigest}.`,
            writeLanguage,
            `You may modify only these candidate pages: ${JSON.stringify(target.pagePaths)}.`,
            "Fix blocking or major defects with source-grounded edits. Return status and a compact summary only.",
          ].join("\n"),
          { label: `repair:${round}:${safeId(target.owner)}`, schema: ENVELOPE },
        )));
        repairs.push(...wave.map((target, index) => ({
          id: `repair:${target.owner}`,
          owner: target.owner,
          status: results[index]?.status ?? "failed",
          receiptPath: `candidate/${target.pagePaths?.[0] ?? ""}`,
          summary: results[index]?.summary ?? "repairer returned no summary",
        })));
      }
      if (repairs.some((entry) => entry.status !== "ok")) return { runId, workdir, finalReview, repairs, stopped: "one or more repairs failed" };
      const repaired = await agent(
        [
          `Repair reducer. workdir=${workdir}. Inspect only these repaired outputs: ${JSON.stringify(conciseLedger(repairs))}.`,
          `Write analysis/receipts/repair-artifacts-round-${round}.json as a JSON array of {id,type,path}.`,
          "Return status and a compact summary only.",
        ].join("\n"),
        { label: `reduce-repair:${round}`, schema: ENVELOPE },
      );
      if (repaired?.status !== "ok") return { runId, workdir, repaired, stopped: "repair reduction failed" };
      const repairCheckpoint = await runHostPublish(agent, {
        workdir,
        phase: `repair-${round}`,
        artifactsJson: `analysis/receipts/repair-artifacts-round-${round}.json`,
        label: `publish:repair-${round}`,
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
      `Recheck candidate, frozen snapshot, ownership, coverage, local source links, indexes, and final review checkpoint ${finalReviewCheckpoint?.checkpointDigest}.`,
      "Write command output to analysis/validation.json and analysis/receipts/validate-artifacts.json as {id,type,path}.",
      "Validation does not change run state; the following publish is the only sealing transition. Return status only after the command succeeds.",
    ].join("\n"),
    { label: "validate-and-seal", schema: ENVELOPE },
  );
  if (validation?.status !== "ok") return { runId, workdir, validation, stopped: "validation failed" };
  const validationCheckpoint = await runHostPublish(agent, {
    workdir,
    phase: "validate",
    artifactsJson: "analysis/receipts/validate-artifacts.json",
    label: "publish:validate",
  });
  if (validationCheckpoint?.status !== "ok") return { runId, workdir, validation, validationCheckpoint, stopped: "validation checkpoint failed" };
  log(`wiki sealed for ${runId}`);
  return { runId, workdir, workspaceRoot, mode: input.mode, review: finalReview, validation, validationCheckpoint, next: "sealed" };
})();
