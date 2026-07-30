/**
 * plan node: produce an unsealed WikiRunSpec via planWikiSpec.
 * Wires RunIntent (focus → operatorNotes), revision feedback, and the scout
 * model (worker role). Replanning never reads a prior Spec artifact.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PiAttemptOutcome,
  PiAttemptOutcomeSchema,
  resolveAdaptiveOrchestration,
} from "@okf-wiki/contract";
import { createSubmitWikiRunSpecTool } from "../../../tools/submit-wiki-run-spec.js";
import { planWikiSpec } from "../../../workflow/phases/plan-phase.js";
import {
  loadProjectedIntent,
  loadProjectedOperatorInput,
  mergeOperatorNotes,
} from "../materialize.js";
import { type AttemptHandlerContext, bounded, liveModel, sealTranscript } from "../shared.js";

/** Coarse inventory from workspace sources (no tree walk — cheap signal). */
function inventoryFromWorkspace(workspace: { sources?: readonly unknown[] }): {
  sourceCount: number;
  multiEntry?: boolean;
  large?: boolean;
} {
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

  const intent = await loadProjectedIntent(layout);
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

  // Phase 7: inventory-based adaptive scouts; replan does not recover a prior Spec.
  const adaptive = resolveAdaptiveOrchestration({
    orchestration: input.workspace.orchestration,
    inventory: inventoryFromWorkspace(input.workspace),
    planUncertainty: 0,
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
      intentMode: intent?.mode,
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
