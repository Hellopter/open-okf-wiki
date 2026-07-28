/**
 * Root write phase (Run Workflow).
 */

import type { WikiWriteResult } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import type { ProgressSink } from "../../ports/progress-sink.js";
import { listWikiMarkdown, materializeWikiIndexes } from "../../produce/wiki-pages.js";
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
  progress: ProgressSink,
  wikiDir: string,
  spec: PhaseContext["spec"],
): Promise<void> {
  const existing = new Set(await listWikiMarkdown(wikiDir));
  const done = (spec.pages ?? [])
    .map((p) => p.path)
    .filter((pagePath) => existing.has(pagePath.replace(/^\.?\//, "")));
  progress.emit({ kind: "pages", pages: done });
}

/** Fail-closed: regenerate multi-level indexes after a successful staging write. */
async function materializeStagingIndexes(
  progress: ProgressSink,
  wikiDir: string,
): Promise<void> {
  const indexes = await materializeWikiIndexes(wikiDir);
  progress.emit({
    kind: "status",
    status: "producing",
    summary: `materialize indexes (${indexes.written.length})`,
  });
}

export async function runWritePhase(ctx: PhaseContext): Promise<WritePhaseResult> {
  const {
    input,
    progress,
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
  progress.emit({
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
      // Tool-edge attempt spans fold into the phase ProgressSink.
      onProgress: (span) => progress.emit({ kind: "attempt", attempt: span }),
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

  await materializeStagingIndexes(progress, produced.layout.wikiDir);
  // Indexes are product-owned; refresh the returned page list after materialize.
  const pages = await listWikiMarkdown(produced.layout.wikiDir);
  produced = { ...produced, pages };
  await emitPagesFromDisk(progress, produced.layout.wikiDir, spec);
  progress.emit({
    kind: "status",
    status: "producing",
    summary: `root_write complete (${produced.pages.length} pages)`,
  });
  progress.emit({ kind: "pages", pages: produced.pages });

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
    progress,
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

  // Total repair attempts across council + hard-validate (each counter is
  // 1-based and already incremented by the bounded loop before this write).
  const totalRepairRounds =
    (metrics.repairRounds ?? 0) + (metrics.hardValidateRepairRounds ?? 0);
  const runIndex = Math.max(0, (totalRepairRounds || 1) - 1);
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
      onProgress: (span) => progress.emit({ kind: "attempt", attempt: span }),
    });
    await materializeStagingIndexes(progress, produced.layout.wikiDir);
    // Indexes are product-owned; refresh the returned page list after materialize.
    const pages = await listWikiMarkdown(produced.layout.wikiDir);
    produced = { ...produced, pages };
    await emitPagesFromDisk(progress, produced.layout.wikiDir, spec);
    progress.emit({
      kind: "status",
      status: "producing",
      summary: `repair complete (${produced.pages.length} pages)`,
    });
    progress.emit({ kind: "pages", pages: produced.pages });
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
