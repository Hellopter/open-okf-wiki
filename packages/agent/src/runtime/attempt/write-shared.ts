/**
 * Shared write path for write.root and repair.
 *
 * Eliminates near-duplicate branches: both materialise a sealed spec, optionally
 * seed a prior wiki tree, build a feedback-first task, call writeWiki, index pages,
 * and seal a transcript with wiki_tree + transcript artifacts.
 */

import { PiAttemptOutcomeSchema, type PiAttemptOutcome } from "@okf-wiki/contract";
import { materializeWikiIndexes } from "../../produce/wiki-pages.js";
import { rootWritePrompt, rootWriteSystemPrompt } from "../../prompts/index.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  readSealedWikiTree,
  readSpec,
  sealTranscript,
  writeAnalysisJson,
} from "./shared.js";

export type WriteSharedMode = "write.root" | "repair";

/**
 * Run the writer (or repair-style writer) for one Attempt.
 *
 * Behaviour differences preserved:
 * - repair: always requires sealed wiki_tree; always graphRole "repair";
 *   repair instruction mentions "blocking defects".
 * - write.root: optional feedback turns the task into repair-style; prior wiki
 *   is best-effort when feedback + sealed wiki_tree exist; graphRole "repair"
 *   only when feedback is present; instruction mentions validation/citation/frontmatter.
 */
export async function runWriteShared(
  ctx: AttemptHandlerContext,
  mode: WriteSharedMode,
): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;

  if (mode === "repair") {
    await readSealedWikiTree(input, layout.wikiDir);
  }

  const spec = await readSpec(input);
  await writeAnalysisJson(layout, "spec.json", spec);

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "writer", resolveModel) : undefined;

  const feedback =
    typeof input.node.detail?.feedback === "string" && input.node.detail.feedback.trim()
      ? input.node.detail.feedback.trim()
      : undefined;

  // write.root with feedback: seed prior wiki when sealed (best-effort).
  if (
    mode === "write.root" &&
    feedback &&
    input.sealedInputs.some((item) => item.role === "wiki_tree")
  ) {
    try {
      await readSealedWikiTree(input, layout.wikiDir);
    } catch {
      // Prior wiki may be absent or unreadable on first write; pure repair still proceeds.
    }
  }

  const baseWritePrompt = rootWritePrompt({
    layout,
    spec,
    wikiLanguage: input.workspace.wikiLanguage,
    multiSource: Object.keys(input.sourcePaths).length > 1,
  });

  // Feedback first so it is not lost when transcripts truncate long write prompts.
  let writeTask: string;
  let asRepair: boolean;
  if (mode === "repair") {
    asRepair = true;
    writeTask = [
      ...(feedback ? [`Operator feedback: ${feedback}`, ""] : []),
      baseWritePrompt,
      "",
      "Repair mode: fix blocking defects on the existing Staging Wiki; preserve good pages.",
    ].join("\n");
  } else if (feedback) {
    asRepair = true;
    writeTask = [
      `Operator feedback: ${feedback}`,
      "",
      baseWritePrompt,
      "",
      "Repair mode: fix validation, citation, and frontmatter defects on the existing Staging Wiki; preserve good pages.",
    ].join("\n");
  } else {
    asRepair = false;
    writeTask = baseWritePrompt;
  }

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
  });

  await materializeWikiIndexes(layout.wikiDir);

  const transcript = await sealTranscript(input, {
    task: writeTask,
    items: produced.items,
    summary: produced.summary,
    terminal: "done",
    meta: {
      mode: produced.mode,
      pages: produced.pages,
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
  });
}
