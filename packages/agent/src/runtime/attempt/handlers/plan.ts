/**
 * plan node: produce an unsealed WikiRunSpec via planWikiSpec.
 * Phase 1: wires RunIntent (focus → operatorNotes), plan revise (priorSpec +
 * revisionFeedback), and scout model (worker role).
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FrozenRunManifestSchema,
  PiAttemptOutcomeSchema,
  type PiAttemptOutcome,
  planUncertaintyFromSpec,
  type RunIntent,
  RunIntentSchema,
  resolveAdaptiveOrchestration,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import { createSubmitWikiRunSpecTool } from "../../../tools/submit-wiki-run-spec.js";
import { planWikiSpec } from "../../../workflow/phases/plan-phase.js";
import {
  loadProjectedOperatorInput,
  mergeOperatorNotes,
} from "../materialize.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  sealTranscript,
} from "../shared.js";

/** Coarse inventory from workspace sources (no tree walk — cheap signal). */
function inventoryFromWorkspace(workspace: {
  sources?: readonly unknown[];
}): { sourceCount: number; multiEntry?: boolean; large?: boolean } {
  const sourceCount = workspace.sources?.length ?? 0;
  return {
    sourceCount,
    multiEntry: sourceCount >= 2,
    large: sourceCount >= 3,
  };
}

export async function handlePlan(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  if (input.node.key !== "plan") {
    throw new Error(`unsupported Pi attempt node: ${input.node.kind}/${input.node.key}`);
  }

  const intent = await loadRunIntent(input);
  // Phase 4: sealed operator_input answer is authoritative for continuation Attempts.
  const operatorInput = await loadProjectedOperatorInput(layout);
  const operatorNotes = mergeOperatorNotes({
    focus: intent?.focus,
    operatorAnswer: operatorInput?.answer,
  });
  const revisionFeedback =
    typeof input.node.detail?.feedback === "string" && input.node.detail.feedback.trim()
      ? input.node.detail.feedback.trim()
      : undefined;
  const isRevise = input.node.generation > 0 || Boolean(revisionFeedback);
  const priorSpec = isRevise ? await loadPriorSpec(input) : undefined;

  // Phase 7: inventory + plan-uncertainty adaptive scouts (default 0 light path).
  const adaptive = resolveAdaptiveOrchestration({
    orchestration: input.workspace.orchestration,
    inventory: inventoryFromWorkspace(input.workspace),
    planUncertainty: priorSpec ? planUncertaintyFromSpec(priorSpec) : 0,
  });

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "planner", resolveModel) : undefined;
  // Scout model: cheaper worker role when live; planWikiSpec falls back to planner model.
  const scoutResolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;

  const planTask = `Plan WikiRunSpec for ${input.workspace.name}`;
  const planned = await planWikiSpec({
    layout,
    workspaceName: input.workspace.name,
    wikiLanguage: input.workspace.wikiLanguage,
    runtime,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    scoutModel: scoutResolved?.model ?? resolved?.model,
    scoutModelRuntime: scoutResolved?.modelRuntime ?? resolved?.modelRuntime,
    scoutMaxContextTokens: scoutResolved?.model.contextWindow ?? resolved?.model.contextWindow,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    orchestration: adaptive.orchestration,
    sourceIgnores: ignores,
    abortSignal: signal,
    operatorNotes,
    ...(priorSpec ? { priorSpec } : {}),
    ...(revisionFeedback ? { revisionFeedback } : {}),
    customTools: [createSubmitWikiRunSpecTool({ runWorkDir: input.workDir })],
    transcriptPath: input.sessionPath,
  });
  const specPath = path.join(layout.analysisDir, "spec.json");
  await writeFile(specPath, `${JSON.stringify(planned.spec, null, 2)}\n`, "utf8");
  const summary = bounded(planned.rawSummary ?? planned.spec.summary);
  const transcript = await sealTranscript(input, {
    task: planTask,
    items: planned.items,
    summary,
    terminal: "done",
    meta: {
      mode: planned.mode,
      source: planned.source,
      intentMode: intent?.mode ?? "generate",
      revise: isRevise,
      ...(operatorInput?.answer ? { operatorInputBound: true } : {}),
    },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "spec", role: "spec", sourcePath: specPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary,
  });
}

/** Load RunIntent from sealed frozen_run_manifest (Phase 1 freeze output). */
async function loadRunIntent(
  input: AttemptHandlerContext["input"],
): Promise<RunIntent | undefined> {
  const sealed = input.sealedInputs.find(
    (item) => item.role === "frozen_run_manifest" || item.role === "manifest",
  );
  if (!sealed) return undefined;
  const candidates = [
    path.join(sealed.readOnlyPath, "frozen-run-manifest.json"),
    sealed.readOnlyPath,
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      const raw = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      const manifest = FrozenRunManifestSchema.safeParse(raw);
      if (manifest.success) return RunIntentSchema.parse(manifest.data.intent);
      const intentOnly = RunIntentSchema.safeParse(raw);
      if (intentOnly.success) return intentOnly.data;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Load prior Spec from sealed prior_spec (plan revise) or role spec. */
async function loadPriorSpec(
  input: AttemptHandlerContext["input"],
): Promise<WikiRunSpec | undefined> {
  const sealed =
    input.sealedInputs.find((item) => item.role === "prior_spec") ??
    input.sealedInputs.find((item) => item.role === "spec");
  if (!sealed) return undefined;
  const candidates = [
    path.join(sealed.readOnlyPath, "spec.json"),
    sealed.readOnlyPath,
    path.join(sealed.readOnlyPath, "analysis", "spec.json"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return WikiRunSpecSchema.parse(JSON.parse(await readFile(candidate, "utf8")));
    } catch {
      // try next
    }
  }
  return undefined;
}
