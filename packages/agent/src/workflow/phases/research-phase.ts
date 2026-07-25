/**
 * Domain + leaf research fan-out (Run Workflow phase).
 */

import type { WorkspaceOrchestration } from "@okf-wiki/contract";
import type { ScopedRunnerProgress } from "../../ports/agent-runner.js";
import { emitProduceProgress } from "../../produce/progress.js";
import { domainResearchPrompt, leafResearchPrompt } from "../../produce/prompts.js";
import { attachResearchReceipt } from "../../produce/receipts.js";
import { decideNodeRetry, isCriticalDomainFailure } from "../retry-policy.js";
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

export async function runResearchPhase(
  ctx: PhaseContext,
  orch: WorkspaceOrchestration,
): Promise<ResearchPhaseResult> {
  const { input, onProgress, runtime, metrics, layout, spec, mode } = ctx;
  const criticalDomainFailures: string[] = [];

  emitProduceProgress(onProgress, {
    kind: "status",
    status: "producing",
    summary: "domain + leaf research",
  });

  const domains = (spec.domains ?? []).slice(0, orch.maxDomainFanOut);
  const workerModel = input.models?.worker ?? input.models?.writer;

  for (const d of domains) {
    throwIfAborted(input.abortSignal);
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
        const leafResults = await runtime.runAgentsParallel(
          leafTasks.map((t) => t.input),
          { concurrency: Math.min(2, leafTasks.length) },
        );
        for (let i = 0; i < leafResults.length; i++) {
          const leafNodeId = leafTasks[i]!.leafNodeId;
          const lr = leafResults[i]!;
          const withPath = await attachResearchReceipt(
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
              status: "complete",
            },
          );
          childReceiptPaths.push(withPath.receiptPath);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            kind: "cancelled",
            result: cancelledResult(spec, mode, metrics, layout),
          };
        }
        // Leaf fan-out is best-effort; domain still runs.
      }
    }

    try {
      const domainResult = await runtime.runAgent({
        role: "domain",
        spanId: domainNodeId,
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
      });
      await attachResearchReceipt(
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
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          kind: "cancelled",
          result: cancelledResult(spec, mode, metrics, layout),
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Policy consult (T1): critical domains fail the run; non-critical may skip.
      const retry = decideNodeRetry({
        errorClass: "quality",
        attemptIndex: 0,
        maxAttempts: 1,
        message: msg,
      });
      void retry;
      await attachResearchReceipt(
        { role: "domain", mode, summary: `FAILED: ${msg}` },
        {
          workspaceRoot: input.workspace.rootPath,
          runId: input.runId,
          nodeId: domainNodeId,
          parentId: "root",
          scope: d.scope ?? d.title ?? d.id,
          status: "failed",
          childReceipts: childReceiptPaths,
          summary: `FAILED: ${msg}`,
        },
      );
      if (isCriticalDomainFailure(d.critical)) {
        criticalDomainFailures.push(`${d.id}: ${msg}`);
      }
    }
  }

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
