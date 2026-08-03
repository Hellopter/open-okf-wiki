/** Bounded research-gap decision between initial evidence and writing. */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type PiAttemptOutcome, PiAttemptOutcomeSchema } from "@okf-wiki/contract/pi-attempt";
import { ExecutionPlanDeltaSchema } from "@okf-wiki/contract/wiki-runs";
import { loadEvidenceBundle } from "../projection.js";
import {
  type AttemptHandlerContext,
  bounded,
  forwardScopedProgress,
  liveModel,
  metricsFromSeatRun,
  seatModelId,
  sealTranscript,
} from "../shared.js";

const ADAPT_SYSTEM =
  "You assess whether bounded additional read-only research is needed before writing. " +
  "You may only propose a small missing evidence question in an existing domain. " +
  "Return exactly one JSON object and no markdown or prose.";

function parseDelta(summary: string) {
  const candidate = summary.trim();
  try {
    return ExecutionPlanDeltaSchema.parse(JSON.parse(candidate));
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("plan adaptation must return a JSON object");
    return ExecutionPlanDeltaSchema.parse(JSON.parse(candidate.slice(start, end + 1)));
  }
}

export async function handlePlanAdapt(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, runtime, resolveModel, signal } = ctx;
  const round = input.node.detail?.adaptRound;
  if (input.node.key !== `plan.adapt.${round}` || !Number.isInteger(round)) {
    throw new Error(`unsupported Pi attempt node: ${input.node.kind}/${input.node.key}`);
  }
  const evidence = await loadEvidenceBundle(layout);
  const receiptIds = evidence?.receipts.map((receipt) => receipt.nodeId).join(", ") || "none";
  const task = [
    `Adaptation round ${round}.`,
    "Read inputs/spec.json and the sealed research receipts under inputs/evidence/receipts/.",
    `Available receipts: ${receiptIds}.`,
    "Return exactly this JSON shape:",
    '{"version":1,"complete":true,"additions":[],"reason":"..."}',
    "Set complete=false only when additions contains one or more missing, bounded questions.",
    "Every addition must use an existing Spec domainId and have stable id, question, and scope.",
  ].join("\n");
  const resolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
  const seat = { modelId: seatModelId(resolved), role: "plan_adapt" as const };
  const result = await runtime.runAgent({
    role: "leaf",
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    runWorkDir: input.workDir,
    task,
    systemPrompt: ADAPT_SYSTEM,
    preferFinalMessage: true,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    sourceIgnores: ctx.ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    transcriptPath: input.sessionPath,
    onProgress: (p) => forwardScopedProgress(ctx, p, seat),
  });
  if (result.failed) throw new Error(result.summary);
  const delta =
    runtime.kind === "fixture"
      ? ExecutionPlanDeltaSchema.parse({ version: 1, complete: true, additions: [] })
      : parseDelta(result.summary);
  const deltaPath = path.join(layout.analysisDir, "execution-plan-delta.json");
  await writeFile(deltaPath, `${JSON.stringify(delta, null, 2)}\n`, "utf8");
  const transcript = await sealTranscript(input, {
    task,
    items: result.items,
    summary: result.summary,
    terminal: "done",
    meta: { mode: result.mode, role: "plan_adapt", round },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "plan_delta", sourcePath: deltaPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(delta.reason ?? (delta.complete ? "research complete" : "research added")),
    metrics: metricsFromSeatRun({
      role: "plan_adapt",
      modelId: seatModelId(resolved),
      fromRun: result.metrics,
      extra: {
        extra: {
          ...(result.metrics?.extra ?? {}),
          additions: delta.additions.length,
        },
      },
    }),
  });
}
