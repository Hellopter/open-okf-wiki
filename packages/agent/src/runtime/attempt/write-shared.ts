/**
 * Shared write path for write.root and repair.
 *
 * Both modes consume Attempt-local projections, build a feedback-first task,
 * call writeWiki, index pages, and seal wiki_tree + transcript artifacts.
 *
 * Phase 2: consume projected EvidenceBundle, defects, and refresh prior wiki.
 */

import {
  type PiAttemptOutcome,
  PiAttemptOutcomeSchema,
  type RepairRequest,
  RepairRequestSchema,
} from "@okf-wiki/contract";
import { digestPublicationTreeContentOnly } from "@okf-wiki/core";
import { materializeWikiIndexes } from "../../produce/wiki-pages.js";
import { rootWritePrompt, rootWriteSystemPrompt } from "../../prompts/index.js";
import {
  formatEvidenceIndex,
  formatOperatorInputNotes,
  loadEvidenceBundle,
  loadProjectedDefectsText,
  loadProjectedIntent,
  loadProjectedOperatorInput,
} from "./materialize.js";
import {
  type AttemptHandlerContext,
  bounded,
  forwardScopedProgress,
  liveModel,
  metricsFromSeatRun,
  readSpec,
  seatModelId,
  sealTranscript,
} from "./shared.js";

export type WriteSharedMode = "write.root" | "repair";

/**
 * Parse the structured RepairRequest from sealed node detail.
 * A write.root feedback pass can be unstructured, but a repair.N node has no
 * valid semantic fallback: scheduling must supply its exact repair envelope.
 */
function loadRepairRequest(
  detail: AttemptHandlerContext["input"]["node"]["detail"],
  required: boolean,
): RepairRequest | undefined {
  const raw = detail && "repairRequest" in detail ? detail.repairRequest : undefined;
  if (raw == null) {
    if (required) throw new Error("repair requires sealed detail.repairRequest");
    return undefined;
  }
  const parsed = RepairRequestSchema.safeParse(raw);
  if (!parsed.success) {
    if (required) throw new Error("repair requires a valid sealed detail.repairRequest");
    return undefined;
  }
  return parsed.data;
}

/** Lead-in block so truncation still keeps repair scope facts. */
function formatRepairRequestBlock(request: RepairRequest): string {
  const lines: string[] = ["RepairRequest:", "```json", JSON.stringify(request, null, 2), "```"];
  if (request.scope.pages.length > 0) {
    lines.push(`Repair scope pages: ${request.scope.pages.join(", ")}`);
  }
  lines.push(`Baseline candidate: ${request.baselineCandidateId}`);
  if (request.mechanicalReportArtifactId) {
    lines.push(
      "Read the complete sealed MechanicalReport at inputs/mechanical-report.json before editing; it is authoritative over this summary.",
    );
  }
  if (request.scope.pages.length > 0) {
    lines.push(
      "Only edit the listed scope pages unless a consistency fix on another page is strictly required.",
    );
  }
  return lines.join("\n");
}

/**
 * Run the writer (or repair-style writer) for one Attempt.
 *
 * Behaviour differences preserved:
 * - repair: materialized wiki baseline; always graphRole "repair";
 *   repair instruction mentions "blocking defects".
 * - write.root: optional feedback turns the task into repair-style; prior wiki
 *   is seeded by materialize for refresh/prior_wiki; graphRole "repair"
 *   only when feedback is present; instruction mentions validation/citation/frontmatter.
 */
export async function runWriteShared(
  ctx: AttemptHandlerContext,
  mode: WriteSharedMode,
): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;

  const intent = await loadProjectedIntent(layout);
  const isRefresh = intent?.mode === "refresh";

  const feedback =
    typeof input.node.detail?.feedback === "string" && input.node.detail.feedback.trim()
      ? input.node.detail.feedback.trim()
      : undefined;
  const repairRequest = loadRepairRequest(input.node.detail, mode === "repair");
  const repairRequestBlock = repairRequest ? formatRepairRequestBlock(repairRequest) : undefined;

  const spec = await readSpec(layout);

  const evidence = await loadEvidenceBundle(layout);
  const receiptIndex = formatEvidenceIndex(evidence);
  const defectsText = await loadProjectedDefectsText(layout);
  const operatorNotes = formatOperatorInputNotes(await loadProjectedOperatorInput(layout));

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "writer", resolveModel) : undefined;

  const baseWritePrompt = rootWritePrompt({
    layout,
    spec,
    wikiLanguage: input.workspace.wikiLanguage,
    multiSource: Object.keys(input.sourcePaths).length > 1,
    receiptIndex,
    repairDefects: defectsText,
    isRefresh: isRefresh || mode === "repair",
  });

  // RepairRequest + feedback first so truncation does not drop sealed facts.
  let writeTask: string;
  let asRepair: boolean;
  if (mode === "repair") {
    asRepair = true;
    writeTask = [
      ...(repairRequestBlock ? [repairRequestBlock, ""] : []),
      ...(operatorNotes ? [operatorNotes, ""] : []),
      ...(feedback ? [`Operator feedback: ${feedback}`, ""] : []),
      baseWritePrompt,
      "",
      "Repair mode: fix blocking defects on the existing Staging Wiki; preserve good pages.",
    ].join("\n");
  } else if (feedback || repairRequest) {
    asRepair = true;
    writeTask = [
      ...(repairRequestBlock ? [repairRequestBlock, ""] : []),
      ...(operatorNotes ? [operatorNotes, ""] : []),
      ...(feedback ? [`Operator feedback: ${feedback}`, ""] : []),
      baseWritePrompt,
      "",
      "Repair mode: fix validation, citation, and frontmatter defects on the existing Staging Wiki; preserve good pages.",
    ].join("\n");
  } else {
    asRepair = false;
    writeTask = operatorNotes ? `${operatorNotes}\n\n${baseWritePrompt}` : baseWritePrompt;
  }

  // Baseline content digest for empty-repair detection (EvaluationRound invariant).
  let baselineWikiDigest: string | undefined;
  if (asRepair) {
    try {
      baselineWikiDigest = await digestPublicationTreeContentOnly(layout.wikiDir);
    } catch {
      baselineWikiDigest = undefined;
    }
  }

  const seat = {
    modelId: seatModelId(resolved),
    role: (mode === "repair" ? "repair" : "writer") as "repair" | "writer",
  };
  const produced = await runtime.writeWiki({
    layout,
    spec,
    workspaceName: input.workspace.name,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    additionalSkillPaths: [layout.skillDir],
    sourceIgnores: ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    systemPrompt: rootWriteSystemPrompt(),
    task: writeTask,
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    ...(asRepair ? { graphRole: "repair" as const } : {}),
    transcriptPath: input.sessionPath,
    onProgress: (p) => forwardScopedProgress(ctx, p, seat),
  });

  await materializeWikiIndexes(layout.wikiDir);

  // Fail closed on no-op repair: digest unchanged means the round did not produce a new candidate.
  if (asRepair && baselineWikiDigest) {
    const afterDigest = await digestPublicationTreeContentOnly(layout.wikiDir);
    if (afterDigest === baselineWikiDigest) {
      throw new Error(
        "repair produced no content change (wiki digest unchanged); empty repair rounds are not allowed",
      );
    }
  }

  const transcript = await sealTranscript(input, {
    task: writeTask,
    items: produced.items,
    summary: produced.summary,
    terminal: "done",
    meta: {
      mode: produced.mode,
      pages: produced.pages,
      isRefresh: Boolean(isRefresh),
      evidenceReceipts: evidence?.receipts.length ?? 0,
      // write.root with feedback tagged repair:true historically; repair node omits it.
      ...(mode === "write.root" && feedback ? { repair: true } : {}),
    },
  });

  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "wiki_tree", role: "wiki_tree", sourcePath: layout.wikiDir, directory: true },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(produced.summary),
    metrics: metricsFromSeatRun({
      role: mode === "repair" ? "repair" : "writer",
      modelId: seatModelId(resolved),
      fromRun: produced.metrics,
    }),
  });
}
