/**
 * Root write phase (Run Workflow).
 */

import type { WikiWriteResult } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import { emitProgress } from "../../ports/progress-sink.js";
import { listWikiMarkdown } from "../../produce/wiki-pages.js";
import { rootWritePrompt, rootWriteSystemPrompt } from "../../prompts/index.js";
import {
  cancelledResult,
  type PhaseContext,
  type ProduceWikiResult,
  throwIfAborted,
} from "./types.js";

export type WritePhaseResult =
  | { kind: "ok"; produced: WikiWriteResult }
  | { kind: "cancelled"; result: ProduceWikiResult };

export async function emitPagesFromDisk(
  onProgress: PhaseContext["onProgress"],
  wikiDir: string,
  spec: PhaseContext["spec"],
): Promise<void> {
  const existing = new Set(await listWikiMarkdown(wikiDir));
  const done = (spec.pages ?? [])
    .map((p) => p.path)
    .filter((pagePath) => existing.has(pagePath.replace(/^\.?\//, "")));
  emitProgress(onProgress, { kind: "pages", pages: done });
}

export async function runWritePhase(ctx: PhaseContext): Promise<WritePhaseResult> {
  const {
    input,
    onProgress,
    runtime,
    metrics,
    multiSource,
    wikiLanguage,
    contextTargetTokens,
    layout,
    spec,
    mode,
  } = ctx;

  throwIfAborted(input.abortSignal);
  emitProgress(onProgress, {
    kind: "status",
    status: "producing",
    summary: "root_write",
  });

  const receiptIndex = await defaultReceiptStore.buildIndex(input.workspace.rootPath, input.runId);
  let produced: WikiWriteResult;
  try {
    produced = await runtime.writeWiki({
      layout,
      spec,
      workspaceName: input.workspace.name,
      model: input.models?.writer?.model,
      modelRuntime: input.models?.writer?.modelRuntime,
      maxContextTokens: input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
      contextTargetTokens,
      additionalSkillPaths: input.additionalSkillPaths,
      sourceIgnores: input.sourceIgnores,
      abortSignal: input.abortSignal,
      systemPrompt: rootWriteSystemPrompt(),
      task: rootWritePrompt({
        layout: layout as Parameters<typeof rootWritePrompt>[0]["layout"],
        spec,
        wikiLanguage,
        multiSource,
        receiptIndex,
      }),
      onProgress: (span) => emitProgress(onProgress, { kind: "attempt", attempt: span }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        kind: "cancelled",
        result: cancelledResult(spec, mode, metrics, layout),
      };
    }
    throw err;
  }

  await emitPagesFromDisk(onProgress, produced.layout.wikiDir, spec);
  emitProgress(onProgress, {
    kind: "status",
    status: "producing",
    summary: `root_write complete (${produced.pages.length} pages)`,
  });
  emitProgress(onProgress, { kind: "pages", pages: produced.pages });

  return { kind: "ok", produced };
}

/**
 * Repair write on existing staging (council loop or operator wiki_repair).
 *
 * Topology has a single `repair` node; each repair round is a new attempt
 * (`repair@{runIndex}`) so multi-round history appends rather than overwriting
 * `root_write`.
 */
export async function runRepairWrite(input: {
  ctx: PhaseContext;
  produced: WikiWriteResult;
  defectText: string;
  receiptIndex: string;
}): Promise<WritePhaseResult> {
  const { ctx, defectText, receiptIndex } = input;
  const {
    input: wikiInput,
    onProgress,
    runtime,
    metrics,
    multiSource,
    wikiLanguage,
    contextTargetTokens,
    layout,
    spec,
    mode,
  } = ctx;
  let produced = input.produced;

  // metrics.repairRounds is 1-based and already incremented by the caller.
  const runIndex = Math.max(0, (metrics.repairRounds || 1) - 1);
  const attemptId = `repair@${runIndex}`;

  try {
    produced = await runtime.writeWiki({
      layout,
      spec,
      workspaceName: wikiInput.workspace.name,
      model: wikiInput.models?.writer?.model,
      modelRuntime: wikiInput.models?.writer?.modelRuntime,
      maxContextTokens: wikiInput.maxContextTokens ?? wikiInput.models?.writer?.maxContextTokens,
      contextTargetTokens,
      additionalSkillPaths: wikiInput.additionalSkillPaths,
      sourceIgnores: wikiInput.sourceIgnores,
      abortSignal: wikiInput.abortSignal,
      systemPrompt: rootWriteSystemPrompt(),
      task: rootWritePrompt({
        layout: layout as Parameters<typeof rootWritePrompt>[0]["layout"],
        spec,
        wikiLanguage,
        multiSource,
        receiptIndex,
        repairDefects: defectText,
      }),
      spanId: attemptId,
      nodeKey: "repair",
      runIndex,
      graphRole: "repair",
      onProgress: (span) => emitProgress(onProgress, { kind: "attempt", attempt: span }),
    });
    await emitPagesFromDisk(onProgress, produced.layout.wikiDir, spec);
    return { kind: "ok", produced };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        kind: "cancelled",
        result: cancelledResult(spec, mode, metrics, layout, produced),
      };
    }
    throw err;
  }
}
