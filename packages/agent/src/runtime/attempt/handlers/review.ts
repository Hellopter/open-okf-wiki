/**
 * review.seat: lens-scoped wiki review Attempt.
 */

import { PiAttemptOutcomeSchema, type PiAttemptOutcome } from "@okf-wiki/contract";
import { listWikiMarkdown } from "../../../produce/wiki-pages.js";
import { type ReviewLens, reviewerPrompt } from "../../../prompts/index.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  parseNodeDetail,
  readSealedWikiTree,
  sealTranscript,
  writeAnalysisJson,
} from "../shared.js";

const REVIEW_SYSTEM =
  "You are a wiki reviewer. Return JSON with clean/defects/summary. Prefer fail-closed blocking only for true defects.";

export async function handleReviewSeat(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  await readSealedWikiTree(input, layout.wikiDir);
  const detail = parseNodeDetail(input);
  const lens = (String(detail.lens ?? "general") as ReviewLens) || "general";
  const pages = await listWikiMarkdown(layout.wikiDir);
  const resolved =
    runtime.kind === "live" ? await liveModel(input, "reviewer", resolveModel) : undefined;
  const reviewTask = reviewerPrompt({ pages, lens });
  const result = await runtime.runAgent({
    role: "reviewer",
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    runWorkDir: input.workDir,
    task: reviewTask,
    systemPrompt: REVIEW_SYSTEM,
    preferFinalMessage: true,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    sourceIgnores: ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    additionalSkillPaths: [layout.skillDir],
    transcriptPath: input.sessionPath,
  });
  if (result.failed) throw new Error(result.summary);
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, {
    lens,
    summary: result.summary,
    mode: result.mode,
  });
  const transcript = await sealTranscript(input, {
    task: reviewTask,
    items: result.items,
    summary: result.summary,
    terminal: "done",
    meta: { mode: result.mode, lens },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "review_seat", sourcePath: receiptPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(result.summary),
  });
}
