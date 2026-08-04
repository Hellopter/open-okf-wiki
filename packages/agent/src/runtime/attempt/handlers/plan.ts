/**
 * plan node: thin wiring to planWikiSpec (Epic D.4 / U2 durable scouts).
 *
 * Handler owns only Attempt edge concerns:
 * load projections / models / tools → call planWikiSpec → write unsealed outputs/metrics.
 * Plan policy (inventory, adaptive orch, sealed scout receipts, assert, draft I/O)
 * lives in workflow/phases/plan-phase. Nested runPlanScouts is gone — scouts are
 * durable plan.scout Attempts whose receipts project into inputs/plan-scouts/.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CoverageAssertError } from "@okf-wiki/contract/coverage";
import { type PiAttemptOutcome, PiAttemptOutcomeSchema } from "@okf-wiki/contract/pi-attempt";
import { SemanticSufficiencyError } from "@okf-wiki/contract/wiki-runs";
import { createSubmitWikiRunSpecTool } from "../../../tools/submit-wiki-run-spec.js";
import {
  planUncertaintyForPriorSpec,
  planWikiSpec,
} from "../../../workflow/phases/plan-phase.js";
import {
  loadProjectedIntent,
  loadProjectedOperatorInput,
  loadProjectedPriorSpec,
  mergeOperatorNotes,
} from "../projection.js";
import {
  type AttemptHandlerContext,
  bounded,
  failAttempt,
  forwardScopedProgress,
  liveModel,
  metricsFromSeatRun,
  seatModelId,
  sealTranscript,
} from "../shared.js";

/** Test seam: re-export prior-spec uncertainty helper from plan deep module. */
export { planUncertaintyForPriorSpec };

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
  const priorSpec = await loadProjectedPriorSpec(layout);

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "planner", resolveModel) : undefined;

  const planTask = `Plan WikiRunSpec for ${input.workspace.name}`;
  const seat = { modelId: seatModelId(resolved), role: "plan" as const };
  let planned;
  try {
    planned = await planWikiSpec({
      layout,
      workspaceName: input.workspace.name,
      wikiLanguage: input.workspace.wikiLanguage,
      runtime,
      model: resolved?.model,
      modelRuntime: resolved?.modelRuntime,
      maxContextTokens: resolved?.model.contextWindow,
      contextTargetTokens: input.workspace.limits.contextTargetTokens,
      retry: input.workspace.limits.retry,
      timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
      orchestration: input.workspace.orchestration,
      workspaceSourceCount: input.workspace.sources?.length ?? 0,
      sourceIgnores: ignores,
      abortSignal: signal,
      operatorNotes,
      ...(revisionFeedback ? { revisionFeedback } : {}),
      ...(priorSpec ? { priorSpec } : {}),
      createCustomTools: ({ orchestration, coveragePlan }) => [
        createSubmitWikiRunSpecTool({
          runWorkDir: input.workDir,
          caps: {
            maxDomainFanOut: orchestration.maxDomainFanOut,
            maxLeafFanOut: orchestration.maxLeafFanOut,
          },
          coveragePlan,
        }),
      ],
      transcriptPath: input.sessionPath,
      onProgress: (p) => forwardScopedProgress(ctx, p, seat),
    });
  } catch (error) {
    // Product dual gates → typed failureClass + gateFailure so the host can
    // re-arm scouts from gap unit ids without parsing free-form error strings.
    if (error instanceof SemanticSufficiencyError) {
      const gaps = Array.isArray(error.result.gaps) ? error.result.gaps : [];
      return failAttempt(input, {
        error,
        failureClass: "semantic_gap",
        gateFailure: {
          kind: "semantic_sufficiency",
          code: error.code ?? "SEMANTIC_GAP",
          ...(gaps.length > 0 ? { gaps: gaps.slice(0, 64) } : {}),
          result: error.result,
        },
        task: planTask,
        meta: {
          mode: "plan",
          gate: "semantic_sufficiency",
        },
      });
    }
    if (error instanceof CoverageAssertError) {
      const gaps = Array.isArray(error.result.gaps) ? error.result.gaps : [];
      return failAttempt(input, {
        error,
        failureClass: "coverage_gap",
        gateFailure: {
          kind: "coverage",
          code: error.code ?? "COVERAGE_GAP",
          ...(gaps.length > 0 ? { gaps: gaps.slice(0, 64) } : {}),
          result: error.result,
        },
        task: planTask,
        meta: {
          mode: "plan",
          gate: "coverage",
        },
      });
    }
    throw error;
  }

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
      priorSpecBound: Boolean(priorSpec),
      rescoutRounds: planned.rescoutRounds ?? 0,
      adaptiveReasons: planned.adaptiveReasons ?? [],
      scoutKinds: planned.scoutKinds ?? [],
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
    metrics: metricsFromSeatRun({
      role: "plan",
      modelId: seatModelId(resolved),
      fromRun: planned.metrics,
      // Persist scout kinds bound for this synthesizer Attempt (display + audit).
      extra: {
        extra: {
          ...(planned.metrics?.extra ?? {}),
          scoutKinds: planned.scoutKinds ?? [],
        },
      },
    }),
  });
}
