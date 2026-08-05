/**
 * wiki-produce - one-shot: plan → auto gate plan → write/review → validate.
 * Claude Dynamic Workflow globals: agent, parallel, phase, log, args.
 *
 * Prefer no args. Active run comes from .wiki-agent/current.json written by `ow run` / `ow freeze`.
 * If approvePlan is set on the pointer, this workflow stops after plan for human `ow approve plan`.
 */

export const meta = {
  name: "wiki-produce",
  description: "End-to-end wiki production: plan, auto gate, write, review, validate",
  phases: [{ title: "Resolve" }, { title: "Plan" }, { title: "Write" }],
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
    source: { type: "string" },
  },
  required: ["runId", "workdir", "workspaceRoot"],
};

const STAGE = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "failed", "stopped"] },
    summary: { type: "string", maxLength: 6000 },
    next: { type: "string" },
    stopped: { type: "string" },
  },
  required: ["status", "summary"],
};

phase("Resolve");
const resolved = await agent(
  [
    "Resolve the active wiki run for end-to-end production.",
    `Prefer explicit args when present: ${JSON.stringify({ runId: args?.runId ?? null, workdir: args?.workdir ?? null })}.`,
    "Else read .wiki-agent/current.json and .wiki-agent/next-action.json from the workspace root.",
    "Else pick the newest frozen/planned/write-ready run under .wiki-agent/runs/*/meta.json.",
    "Return absolute workdir, workspaceRoot (directory containing .wiki-agent), approvePlan flag, and current phase/command.",
    "Fail closed if no run exists — operator must run: ow run [--focus TEXT].",
  ].join("\n"),
  { label: "resolve-active-run", schema: RESOLVE },
);

const runId = resolved?.runId;
const workdir = resolved?.workdir;
const workspaceRoot = resolved?.workspaceRoot;
if (typeof runId !== "string" || !runId || typeof workdir !== "string" || !workdir || typeof workspaceRoot !== "string" || !workspaceRoot) {
  return { stopped: "no active run; run: ow run [--focus TEXT] then /wiki-produce" };
}
const approvePlan = resolved?.approvePlan === true;
const phaseHint = String(resolved?.phase || resolved?.command || "");

// Skip plan stage when already write-ready.
const alreadyWriteReady =
  /write-ready|wiki-write-review/i.test(phaseHint) ||
  resolved?.command === "/wiki-write-review";

let planStage = null;
if (!alreadyWriteReady) {
  phase("Plan");
  planStage = await agent(
    [
      `You are the parent orchestrator handoff for plan+gate of run ${runId}.`,
      `Workspace root: ${workspaceRoot}. Workdir: ${workdir}.`,
      `Execute the same work as the /wiki-plan workflow for this run:`,
      `1) Survey every required coverage unit from frozen sources under ${workdir}/sources/.`,
      `2) Write ${workdir}/analysis/discovery-map.json and ${workdir}/analysis/spec.json following ${workdir}/skill/references/*.md.`,
      `3) Unless approvePlan=${approvePlan}, run host CLI gate plan automatically:`,
      `   <hostCli.node> <hostCli.script> gate plan --run ${runId} --workspace <hostCli.workspaceRoot>`,
      `   using hostCli from ${workdir}/inputs/run-policy.json.`,
      `4) If approvePlan is true, do NOT run gate plan; stop after Spec with next=ow approve plan.`,
      `Honor wikiLanguage and multi-source depth rules from run-policy/inventory.`,
      `Return status=ok only when Spec exists and (approvePlan ? stopped for approval : gate plan succeeded).`,
      `summary must include wikiLanguage and whether gate ran.`,
    ].join("\n"),
    { label: "produce-plan-stage", schema: STAGE },
  );

  if (planStage?.status === "stopped" || approvePlan) {
    return {
      runId,
      workdir,
      workspaceRoot,
      approvePlan: true,
      plan: planStage,
      next: `ow approve plan --run ${runId}`,
      stopped: "waiting for human plan approval",
    };
  }
  if (planStage?.status !== "ok") {
    return {
      runId,
      workdir,
      workspaceRoot,
      plan: planStage,
      stopped: planStage?.stopped || "plan/gate stage failed",
    };
  }
}

phase("Write");
const writeStage = await agent(
  [
    `You are the parent orchestrator handoff for write/review/validate of run ${runId}.`,
    `Workspace root: ${workspaceRoot}. Workdir: ${workdir}.`,
    `Execute the same work as the /wiki-write-review workflow for this run:`,
    `1) Preflight with host: gate check --run ${runId} (must pass; receipt digests must match).`,
    `2) Write Spec pages under ${workdir}/candidate/ with local Source Citations only.`,
    `3) Independent review lenses, defects.json, one repair round if needed.`,
    `4) Host validate --run ${runId} to seal.`,
    `Follow ${workdir}/skill/ references and run-policy wikiLanguage / multi-source depth.`,
    `Return status=ok only when validate seals successfully.`,
  ].join("\n"),
  { label: "produce-write-stage", schema: STAGE },
);

if (writeStage?.status !== "ok") {
  return {
    runId,
    workdir,
    workspaceRoot,
    plan: planStage,
    write: writeStage,
    stopped: writeStage?.stopped || "write/review/validate stage failed",
  };
}

log(`wiki-produce finished for ${runId}`);
return {
  runId,
  workdir,
  workspaceRoot,
  plan: planStage,
  write: writeStage,
  next: "done",
};
