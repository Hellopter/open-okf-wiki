/**
 * Domain + leaf research fan-out (Run Workflow phase).
 *
 * Domain units (leaf fan-out + domain reduce) have independent scopes and run
 * under bounded parallelism (orchestration.domainConcurrency). Domain reduce
 * failures get one policy-driven retry (runAttemptWithRetry + retry-policy);
 * retry attempts append to the Run Graph as `domain-x@retryN` under nodeKey
 * `domain-x` with runIndex = attempt index.
 */

import type { WorkspaceOrchestration } from "@okf-wiki/contract";
import type { ScopedRunnerProgress } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import type { ReceiptStore } from "../../ports/receipt-store.js";
import { emitProduceProgress } from "../../produce/progress.js";
import { domainResearchPrompt, leafResearchPrompt } from "../../prompts/index.js";
import { runAttemptWithRetry } from "../attempt-retry.js";
import { isCriticalDomainFailure } from "../retry-policy.js";
import {
  cancelledResult,
  type PhaseContext,
  type ProduceWikiResult,
  throwIfAborted,
} from "./types.js";

export type ResearchPhaseResult =
  | { kind: "ok" }
  | { kind: "cancelled"; result: ProduceWikiResult }
  | { kind: "failed"; result: ProduceWikiResult };

type DomainUnitOutcome =
  | { kind: "ok" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string; critical: boolean };

/** Bounded-parallel map preserving item order; stops launching after abort. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

export async function runResearchPhase(
  ctx: PhaseContext,
  orch: WorkspaceOrchestration,
  receipts: ReceiptStore = defaultReceiptStore,
): Promise<ResearchPhaseResult> {
  const { input, onProgress, runtime, metrics, layout, spec, mode } = ctx;

  emitProduceProgress(onProgress, {
    kind: "status",
    status: "producing",
    summary: "domain + leaf research",
  });

  const domains = (spec.domains ?? []).slice(0, orch.maxDomainFanOut);
  const workerModel = input.models?.worker ?? input.models?.writer;

  const runDomainUnit = async (d: (typeof domains)[number]): Promise<DomainUnitOutcome> => {
    metrics.domainStarts += 1;
    const domainNodeId = `domain-${d.id}`;

    const leafQuestions = (d.questions ?? []).slice(0, orch.maxLeafFanOut);
    const childReceiptPaths: string[] = [];

    if (leafQuestions.length > 0 && orch.maxDepth >= 2) {
      const leafTasks = leafQuestions.map((q, li) => {
        metrics.leafStarts += 1;
        const leafNodeId = `leaf-${d.id}-${li + 1}`;
        return {
          leafNodeId,
          input: {
            role: "leaf" as const,
            spanId: leafNodeId,
            runWorkDir: layout.runWorkDir,
            task: leafResearchPrompt({
              domainId: d.id,
              question: q,
              scope: d.scope ?? "",
              nodeId: leafNodeId,
              runId: input.runId,
            }),
            model: workerModel?.model,
            modelRuntime: workerModel?.modelRuntime,
            maxContextTokens: workerModel?.maxContextTokens,
            contextTargetTokens: ctx.contextTargetTokens,
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: (span: ScopedRunnerProgress) =>
              emitProduceProgress(onProgress, { kind: "attempt", attempt: span }),
          },
        };
      });

      try {
        // Per-task settle: a failed leaf comes back with `failed: true` while
        // sibling leaves keep their results (never discard the whole batch).
        const leafResults = await runtime.runAgentsParallel(
          leafTasks.map((t) => t.input),
          { concurrency: Math.min(2, leafTasks.length) },
        );
        for (let i = 0; i < leafResults.length; i++) {
          const leafNodeId = leafTasks[i]!.leafNodeId;
          const lr = leafResults[i]!;
          const withPath = await receipts.attach(
            {
              role: lr.role,
              mode: lr.mode,
              summary: lr.summary,
            },
            {
              workspaceRoot: input.workspace.rootPath,
              runId: input.runId,
              nodeId: leafNodeId,
              parentId: domainNodeId,
              scope: `${d.id}: ${leafQuestions[i]}`,
              status: lr.failed ? "failed" : "complete",
              ...(lr.failed ? { summary: lr.summary } : {}),
            },
          );
          childReceiptPaths.push(withPath.receiptPath);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return { kind: "cancelled" };
        }
        // Leaf fan-out infrastructure failure is best-effort; domain still runs.
      }
    }

    // Retry policy (T1): failed domain attempts get one policy-driven retry
    // (transient/unknown classes); then the failure is recorded and critical
    // domains fail the run.
    try {
      const domainResult = await runAttemptWithRetry({
        maxAttempts: 2,
        abortSignal: input.abortSignal,
        run: (attempt) =>
          runtime.runAgent({
            role: "domain",
            spanId: attempt === 0 ? domainNodeId : `${domainNodeId}@retry${attempt}`,
            nodeKey: domainNodeId,
            runIndex: attempt,
            runWorkDir: layout.runWorkDir,
            task: domainResearchPrompt({
              domainId: d.id,
              title: d.title ?? d.id,
              scope: d.scope ?? "",
              questions: d.questions ?? [],
              nodeId: domainNodeId,
              runId: input.runId,
            }),
            model: workerModel?.model,
            modelRuntime: workerModel?.modelRuntime,
            maxContextTokens: workerModel?.maxContextTokens,
            contextTargetTokens: ctx.contextTargetTokens,
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: (span: ScopedRunnerProgress) =>
              emitProduceProgress(onProgress, { kind: "attempt", attempt: span }),
          }),
      });
      await receipts.attach(
        {
          role: domainResult.role,
          mode: domainResult.mode,
          summary: domainResult.summary,
        },
        {
          workspaceRoot: input.workspace.rootPath,
          runId: input.runId,
          nodeId: domainNodeId,
          parentId: "root",
          scope: d.scope ?? d.title ?? d.id,
          status: "complete",
          childReceipts: childReceiptPaths,
        },
      );
      return { kind: "ok" };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { kind: "cancelled" };
      }
      const lastFailure = err instanceof Error ? err.message : String(err);
      await receipts.attach(
        { role: "domain", mode, summary: `FAILED: ${lastFailure}` },
        {
          workspaceRoot: input.workspace.rootPath,
          runId: input.runId,
          nodeId: domainNodeId,
          parentId: "root",
          scope: d.scope ?? d.title ?? d.id,
          status: "failed",
          childReceipts: childReceiptPaths,
          summary: `FAILED: ${lastFailure}`,
        },
      );
      return {
        kind: "failed",
        message: `${d.id}: ${lastFailure}`,
        critical: isCriticalDomainFailure(d.critical),
      };
    }
  };

  throwIfAborted(input.abortSignal);
  const outcomes = await mapWithConcurrency(
    domains,
    orch.domainConcurrency ?? 2,
    input.abortSignal,
    (d) => runDomainUnit(d),
  );

  if (input.abortSignal?.aborted || outcomes.some((o) => o?.kind === "cancelled")) {
    return {
      kind: "cancelled",
      result: cancelledResult(spec, mode, metrics, layout),
    };
  }

  const criticalDomainFailures = outcomes.flatMap((o) =>
    o?.kind === "failed" && o.critical ? [o.message] : [],
  );

  if (criticalDomainFailures.length > 0) {
    emitProduceProgress(onProgress, {
      kind: "status",
      status: "producing",
      summary: `critical domain research failed: ${criticalDomainFailures[0]}`,
    });
    return {
      kind: "failed",
      result: {
        status: "failed",
        pages: [],
        summary: `Critical domain research failed: ${criticalDomainFailures.join("; ")}`,
        spec,
        defects: null,
        publishability: {
          publishable: false,
          reasons: criticalDomainFailures.map((f) => `domain: ${f}`),
          pages: [],
          defects: null,
        },
        layout,
        mode,
        metrics,
      },
    };
  }

  return { kind: "ok" };
}
