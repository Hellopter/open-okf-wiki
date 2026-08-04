/**
 * plan.scout: durable single-task plan scout Attempt (U2).
 *
 * Worker model, fail-closed for critical empty summaries, soft-success for
 * optional scouts (empty or agent soft-fail). Seals scout_receipt JSON +
 * transcript; also writes analysis/plan-scouts/<slug>.md for local inspection.
 */

import { type PiAttemptOutcome, PiAttemptOutcomeSchema } from "@okf-wiki/contract/pi-attempt";
import { scoutTaskFileSlug, scoutTaskLabel } from "@okf-wiki/contract/wiki-runs";
import {
  planScoutTaskFromDetail,
  runOnePlanScout,
} from "../../../workflow/phases/plan-scouts.js";
import { formatOperatorInputNotes, loadProjectedOperatorInput } from "../projection.js";
import {
  type AttemptHandlerContext,
  bounded,
  failAttempt,
  forwardScopedProgress,
  liveModel,
  metricsFromSeatRun,
  parseNodeDetail,
  seatModelId,
  sealTranscript,
} from "../shared.js";

const SCOUT_SYSTEM =
  "You are a read-only plan scout. Inspect sources/ and return a compact structured report. Do not write wiki pages.";

export async function handlePlanScout(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  if (input.node.kind !== "plan.scout") {
    throw new Error(`unsupported Pi attempt node: ${input.node.kind}/${input.node.key}`);
  }

  const detail = parseNodeDetail(input);
  const task = planScoutTaskFromDetail({
    scoutKind: typeof detail.scoutKind === "string" ? detail.scoutKind : undefined,
    unitId: typeof detail.unitId === "string" ? detail.unitId : undefined,
    sourceId: typeof detail.sourceId === "string" ? detail.sourceId : undefined,
    surfacePath: typeof detail.surfacePath === "string" ? detail.surfacePath : undefined,
    critical: typeof detail.critical === "boolean" ? detail.critical : undefined,
    taskLabel: typeof detail.taskLabel === "string" ? detail.taskLabel : undefined,
  });
  const slug = scoutTaskFileSlug(task);
  const label =
    (typeof detail.taskLabel === "string" && detail.taskLabel.trim()) || scoutTaskLabel(task);
  const critical = task.required;

  const operatorNotes = formatOperatorInputNotes(await loadProjectedOperatorInput(layout));
  const resolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
  const seat = { modelId: seatModelId(resolved), role: "plan_scout" as const };

  // Optional scouts soft-fail agent errors; critical scouts fail the Attempt.
  const softFail = !critical;

  let result: Awaited<ReturnType<typeof runOnePlanScout>>;
  try {
    result = await runOnePlanScout({
      layout,
      workspaceName: input.workspace.name,
      runtime,
      task,
      ...(operatorNotes ? { operatorNotes } : {}),
      model: resolved?.model,
      modelRuntime: resolved?.modelRuntime,
      maxContextTokens: resolved?.model.contextWindow,
      contextTargetTokens: input.workspace.limits.contextTargetTokens,
      sourceIgnores: ignores,
      abortSignal: signal,
      onProgress: (p) => forwardScopedProgress(ctx, p, seat),
      nodeKey: input.node.key,
      spanId: input.attemptId,
      runIndex: input.node.runIndex,
      transcriptPath: input.sessionPath,
      softFail,
      timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
      retry: input.workspace.limits.retry,
    });
  } catch (error) {
    // Critical path: agent throw or softFail=false.
    return failAttempt(input, {
      error,
      failureClass: "schema",
      task: `Plan scout ${label}`,
      meta: { mode: "plan.scout", scoutKind: detail.scoutKind, critical, slug },
    });
  }

  // Fail-closed: required scout with empty summary must not succeed.
  if (critical && !result.receipt.ok) {
    return failAttempt(input, {
      error: new Error(
        `critical plan scout ${label} returned empty or failed summary (coverage gap)`,
      ),
      failureClass: "schema",
      task: `Plan scout ${label}`,
      unsealedArtifacts: [
        {
          kind: "receipt",
          role: "scout_receipt",
          sourcePath: result.receiptAbsPath,
          directory: false,
        },
      ],
      items: result.child?.items,
      meta: {
        mode: "plan.scout",
        scoutKind: detail.scoutKind,
        critical,
        slug,
        ok: false,
      },
    });
  }

  if (result.child?.failed && critical) {
    return failAttempt(input, {
      error: new Error(result.child.summary || `critical plan scout ${label} failed`),
      failureClass: "schema",
      task: `Plan scout ${label}`,
      unsealedArtifacts: [
        {
          kind: "receipt",
          role: "scout_receipt",
          sourcePath: result.receiptAbsPath,
          directory: false,
        },
      ],
      items: result.child.items,
      meta: { mode: "plan.scout", scoutKind: detail.scoutKind, critical, slug },
    });
  }

  const summary = bounded(
    result.receipt.summary ||
      (result.receipt.ok ? `Plan scout ${label}` : `Plan scout ${label} (soft-empty)`),
  );
  const transcript = await sealTranscript(input, {
    task: `Plan scout ${label}`,
    items: result.child?.items,
    summary,
    terminal: "done",
    meta: {
      mode: result.child?.mode ?? runtime.kind,
      role: "plan_scout",
      scoutKind: detail.scoutKind,
      critical,
      slug,
      ok: result.receipt.ok,
      systemPrompt: SCOUT_SYSTEM,
    },
  });

  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      {
        kind: "receipt",
        role: "scout_receipt",
        sourcePath: result.receiptAbsPath,
        directory: false,
        summary,
      },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary,
    metrics: metricsFromSeatRun({
      role: "plan_scout",
      modelId: seatModelId(resolved),
      fromRun: result.child?.metrics,
      extra: {
        extra: {
          scoutKind: typeof detail.scoutKind === "string" ? detail.scoutKind : slug,
          critical,
          ok: result.receipt.ok,
        },
      },
    }),
  });
}
