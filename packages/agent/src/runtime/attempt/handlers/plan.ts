/**
 * plan node: produce an unsealed WikiRunSpec via planWikiSpec.
 * Wires RunIntent (focus → operatorNotes), revision feedback, prior Spec,
 * inventory-backed adaptive orchestration, and the scout model (worker role).
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PiAttemptOutcome,
  PiAttemptOutcomeSchema,
  planUncertaintyFromSpec,
  type RepositoryInventory,
  resolveAdaptiveOrchestration,
  resolveOrchestration,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import { createSubmitWikiRunSpecTool } from "../../../tools/submit-wiki-run-spec.js";
import {
  type CoverageArtifacts,
  resolveCoverageArtifacts,
} from "../../../workflow/phases/coverage-bridge.js";
import { planWikiSpec } from "../../../workflow/phases/plan-phase.js";
import {
  loadProjectedIntent,
  loadProjectedOperatorInput,
  loadProjectedPriorSpec,
  mergeOperatorNotes,
} from "../materialize.js";
import {
  type AttemptHandlerContext,
  bounded,
  forwardScopedProgress,
  liveModel,
  metricsFromSeatRun,
  seatModelId,
  sealTranscript,
} from "../shared.js";

/**
 * Coarse inventory from workspace sources only (no tree walk).
 * Used when mounts are unavailable or coverage walk fails.
 */
function inventoryFromWorkspace(workspace: { sources?: readonly unknown[] }): {
  sourceCount: number;
  multiEntry?: boolean;
  large?: boolean;
} {
  const sourceCount = workspace.sources?.length ?? 0;
  return {
    sourceCount,
    // multiEntry must not be inferred from multi-source alone.
    multiEntry: false,
    large: false,
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
  const priorSpec = await loadProjectedPriorSpec(layout);

  // Fail-closed: mounted freeze sources must not exceed maxSourcesPerRun.
  const maxSources =
    input.workspace.orchestration?.maxSourcesPerRun ??
    input.workspace.sources?.length ??
    16;
  const workspaceSourceCount = input.workspace.sources?.length ?? 0;
  const mountCount = layout.sourceMounts?.size ?? 0;
  const sourceCount = Math.max(workspaceSourceCount, mountCount);
  if (sourceCount > maxSources) {
    throw new Error(
      `plan: ${sourceCount} sources exceed maxSourcesPerRun=${maxSources}; ` +
        `reduce freeze sources or raise workspace.orchestration.maxSourcesPerRun ` +
        `(silent truncation is not allowed)`,
    );
  }

  // Prefer core inventory walk over workspace sourceCount alone.
  let coverageArtifacts: CoverageArtifacts | undefined;
  let inventorySignals: RepositoryInventory = inventoryFromWorkspace(input.workspace);
  if (runtime.kind === "live" && layout.sourceMounts && layout.sourceMounts.size > 0) {
    try {
      // Pre-adaptive orch for inventory resolve; adaptive re-resolve after signals.
      const baseOrch = resolveOrchestration(input.workspace.orchestration);
      coverageArtifacts = await resolveCoverageArtifacts({
        layout,
        orch: baseOrch,
        sourceMounts: layout.sourceMounts,
        sourceIgnores: ignores instanceof Map ? ignores : undefined,
        abortSignal: signal,
      });
      inventorySignals = {
        sourceCount: coverageArtifacts.adaptive.sourceCount,
        multiEntry: coverageArtifacts.adaptive.multiEntry,
        large: coverageArtifacts.adaptive.large,
        ...(coverageArtifacts.adaptive.fileCount !== undefined
          ? { fileCount: coverageArtifacts.adaptive.fileCount }
          : {}),
        ...(coverageArtifacts.adaptive.languages
          ? { languages: coverageArtifacts.adaptive.languages }
          : {}),
        ...(coverageArtifacts.adaptive.surfaceCount !== undefined
          ? { surfaceCount: coverageArtifacts.adaptive.surfaceCount }
          : {}),
        ...(coverageArtifacts.adaptive.sources
          ? { sources: coverageArtifacts.adaptive.sources }
          : {}),
      };
    } catch (err) {
      // Inventory walk failure on live is fail-closed when multi-source.
      if (sourceCount >= 2) {
        throw err instanceof Error
          ? err
          : new Error(`plan inventory failed: ${String(err)}`);
      }
      // Small single-source: fall back to workspace signals.
      inventorySignals = inventoryFromWorkspace(input.workspace);
    }
  }

  // planUncertainty from prior Spec when revising; else 0 for green-field.
  const planUncertainty = priorSpec ? planUncertaintyFromSpec(priorSpec) : 0;

  const adaptive = resolveAdaptiveOrchestration({
    orchestration: input.workspace.orchestration,
    inventory: inventorySignals,
    planUncertainty,
  });

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "planner", resolveModel) : undefined;
  // Scout model: cheaper worker role when live; planWikiSpec falls back to planner model.
  const scoutResolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;

  const planTask = `Plan WikiRunSpec for ${input.workspace.name}`;
  const seat = { modelId: seatModelId(resolved), role: "plan" as const };
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
    ...(priorSpec ? { priorSpec } : {}),
    ...(coverageArtifacts ? { coverageArtifacts } : {}),
    customTools: [
      createSubmitWikiRunSpecTool({
        runWorkDir: input.workDir,
        caps: {
          maxDomainFanOut: adaptive.orchestration.maxDomainFanOut,
          maxLeafFanOut: adaptive.orchestration.maxLeafFanOut,
        },
        ...(coverageArtifacts?.plan ? { coveragePlan: coverageArtifacts.plan } : {}),
      }),
    ],
    transcriptPath: input.sessionPath,
    onProgress: (p) => forwardScopedProgress(ctx, p, seat),
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
      priorSpecBound: Boolean(priorSpec),
      rescoutRounds: planned.rescoutRounds ?? 0,
      adaptiveReasons: adaptive.reasons,
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
      // Persist scout list on the durable plan attempt so Run Graph can
      // project plan.scout display nodes without durable DAG scheduling.
      extra: {
        extra: {
          ...(planned.metrics?.extra ?? {}),
          scoutKinds: planned.scoutKinds ?? [],
        },
      },
    }),
  });
}

/** Test seam: expose prior-spec aware revise path without full handler. */
export function planUncertaintyForPriorSpec(spec: WikiRunSpec | undefined): number {
  return spec ? planUncertaintyFromSpec(spec) : 0;
}
