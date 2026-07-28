/**
 * Domain + leaf research fan-out (Run Workflow phase).
 *
 * Domain units (leaf fan-out + domain reduce) have independent scopes and run
 * under bounded parallelism (orchestration.domainConcurrency). Domain reduce
 * failures go through runNodeAttempt + retry-policy; L2 does not retry
 * transient/capacity/budget/policy/unknown (fail closed). Schema/quality may
 * still get one repair-style retry when classified that way.
 *
 * Retry budgets (single place):
 * - leaf research: maxAttempts = 1 (no retry; sibling leaves settle independently)
 * - domain research: maxAttempts = 2 (schema/quality only; transport is L0)
 */

import type { AttemptRole, WorkspaceOrchestration } from "@okf-wiki/contract";
import type { ScopedRunnerProgress } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import type { ReceiptStore, ResearchChildResult } from "../../ports/receipt-store.js";
import { domainResearchPrompt, leafResearchPrompt } from "../../prompts/index.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";
import { isCriticalDomainFailure } from "../retry-policy.js";
import { runNodeAttempt, type RunNodeAttemptOptions } from "../run-node-attempt.js";
import {
  cancelledResult,
  failedProduceResult,
  type PhaseContext,
  type ProduceWikiResult,
  throwIfAborted,
} from "./types.js";

/** Explicit research retry budgets — leaf vs domain (document once). */
export const RESEARCH_MAX_ATTEMPTS = {
  leaf: 1,
  domain: 2,
} as const;

export type ResearchPhaseResult =
  | { kind: "ok" }
  | { kind: "cancelled"; result: ProduceWikiResult }
  | { kind: "failed"; result: ProduceWikiResult };

type DomainUnitOutcome =
  | { kind: "ok" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string; critical: boolean };

/**
 * Bind workspace/run to ReceiptStore attach helpers for leaf + domain units.
 */
export function createReceiptAttacher(
  receipts: ReceiptStore,
  workspaceRoot: string,
  runId: string,
) {
  return {
    async attachLeaf(input: {
      child: ResearchChildResult;
      leafNodeId: string;
      domainNodeId: string;
      scope: string;
      failed: boolean;
    }) {
      return receipts.attach(
        {
          role: input.child.role,
          mode: input.child.mode,
          summary: input.child.summary,
        },
        {
          workspaceRoot,
          runId,
          nodeId: input.leafNodeId,
          parentId: input.domainNodeId,
          scope: input.scope,
          status: input.failed ? "failed" : "complete",
          ...(input.failed ? { summary: input.child.summary } : {}),
        },
      );
    },

    async attachDomainComplete(input: {
      child: ResearchChildResult;
      domainNodeId: string;
      scope: string;
      childReceiptPaths: string[];
    }) {
      return receipts.attach(
        {
          role: input.child.role,
          mode: input.child.mode,
          summary: input.child.summary,
        },
        {
          workspaceRoot,
          runId,
          nodeId: input.domainNodeId,
          parentId: "root",
          scope: input.scope,
          status: "complete",
          childReceipts: input.childReceiptPaths,
        },
      );
    },

    async attachDomainFailed(input: {
      mode: "fixture" | "live";
      domainNodeId: string;
      scope: string;
      childReceiptPaths: string[];
      message: string;
    }) {
      const summary = `FAILED: ${input.message}`;
      return receipts.attach(
        { role: "domain", mode: input.mode, summary },
        {
          workspaceRoot,
          runId,
          nodeId: input.domainNodeId,
          parentId: "root",
          scope: input.scope,
          status: "failed",
          childReceipts: input.childReceiptPaths,
          summary,
        },
      );
    },
  };
}

export type ReceiptAttacher = ReturnType<typeof createReceiptAttacher>;

type ResearchUnitKind = "leaf" | "domain";

/**
 * Shared research unit runner: explicit maxAttempts per kind.
 * Leaves typically use runAgentsParallel (maxAttempts=1 semantics);
 * domains use this with runNodeAttempt.
 */
export async function runResearchUnit<T>(input: {
  kind: ResearchUnitKind;
  maxAttempts?: number;
  abortSignal?: AbortSignal;
  nodeKey: string;
  role: AttemptRole;
  attemptId: (attempt: number) => string;
  run: (attempt: number) => Promise<T>;
  onExhausted?: RunNodeAttemptOptions<T>["onExhausted"];
}): Promise<T> {
  const maxAttempts = input.maxAttempts ?? RESEARCH_MAX_ATTEMPTS[input.kind];
  return runNodeAttempt({
    maxAttempts,
    abortSignal: input.abortSignal,
    nodeKey: input.nodeKey,
    role: input.role,
    attemptId: input.attemptId,
    onExhausted: input.onExhausted ?? "throw",
    run: input.run,
  });
}

export async function runResearchPhase(
  ctx: PhaseContext,
  orch: WorkspaceOrchestration,
  receipts: ReceiptStore = defaultReceiptStore,
): Promise<ResearchPhaseResult> {
  const { input, progress, runtime, metrics, layout, spec, mode } = ctx;

  progress.emit({
    kind: "status",
    status: "producing",
    summary: "domain + leaf research",
  });

  const domains = (spec.domains ?? []).slice(0, orch.maxDomainFanOut);
  const workerModel = input.models?.worker ?? input.models?.writer;
  const attach = createReceiptAttacher(receipts, input.workspace.rootPath, input.runId);

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
            systemPrompt:
              "You are a leaf researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.",
            preferFinalMessage: false,
            model: workerModel?.model,
            modelRuntime: workerModel?.modelRuntime,
            maxContextTokens: workerModel?.maxContextTokens,
            contextTargetTokens: ctx.contextTargetTokens,
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: (span: ScopedRunnerProgress) =>
              progress.emit({ kind: "attempt", attempt: span }),
          },
        };
      });

      try {
        // Leaf policy: RESEARCH_MAX_ATTEMPTS.leaf === 1 — single parallel settle;
        // a failed leaf keeps sibling results (no runNodeAttempt retry).
        const leafResults = await runtime.runAgentsParallel(
          leafTasks.map((t) => t.input),
          { concurrency: Math.min(2, leafTasks.length) },
        );
        for (let i = 0; i < leafResults.length; i++) {
          const leafNodeId = leafTasks[i]!.leafNodeId;
          const lr = leafResults[i]!;
          const withPath = await attach.attachLeaf({
            child: {
              role: lr.role,
              mode: lr.mode,
              summary: lr.summary,
            },
            leafNodeId,
            domainNodeId,
            scope: `${d.id}: ${leafQuestions[i]}`,
            failed: Boolean(lr.failed),
          });
          childReceiptPaths.push(withPath.receiptPath);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return { kind: "cancelled" };
        }
        // Leaf fan-out infrastructure failure is best-effort; domain still runs.
      }
    }

    // Domain maxAttempts=2: schema/quality may retry once; transport/unknown fail closed.
    try {
      const domainResult = await runResearchUnit({
        kind: "domain",
        maxAttempts: RESEARCH_MAX_ATTEMPTS.domain,
        abortSignal: input.abortSignal,
        nodeKey: domainNodeId,
        role: "domain",
        attemptId: (attempt) =>
          attempt === 0 ? domainNodeId : `${domainNodeId}@retry${attempt}`,
        onExhausted: "throw",
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
            systemPrompt:
              "You are a domain researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.",
            preferFinalMessage: false,
            model: workerModel?.model,
            modelRuntime: workerModel?.modelRuntime,
            maxContextTokens: workerModel?.maxContextTokens,
            contextTargetTokens: ctx.contextTargetTokens,
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: (span: ScopedRunnerProgress) =>
              progress.emit({ kind: "attempt", attempt: span }),
          }),
      });
      await attach.attachDomainComplete({
        child: {
          role: domainResult.role,
          mode: domainResult.mode,
          summary: domainResult.summary,
        },
        domainNodeId,
        scope: d.scope ?? d.title ?? d.id,
        childReceiptPaths,
      });
      return { kind: "ok" };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { kind: "cancelled" };
      }
      const lastFailure = err instanceof Error ? err.message : String(err);
      await attach.attachDomainFailed({
        mode,
        domainNodeId,
        scope: d.scope ?? d.title ?? d.id,
        childReceiptPaths,
        message: lastFailure,
      });
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
    progress.emit({
      kind: "status",
      status: "producing",
      summary: `critical domain research failed: ${criticalDomainFailures[0]}`,
    });
    return {
      kind: "failed",
      result: failedProduceResult({
        summary: `Critical domain research failed: ${criticalDomainFailures.join("; ")}`,
        pages: [],
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
      }),
    };
  }

  return { kind: "ok" };
}
