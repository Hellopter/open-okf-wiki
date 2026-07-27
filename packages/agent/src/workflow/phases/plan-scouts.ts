/**
 * Parallel plan scouts (MoA proposers) before the Spec synthesizer.
 *
 * Scouts are read-only; they write analysis/plan-scouts/*.md receipts for the
 * planner to consume. Failures are soft: the synthesizer still runs with
 * whatever scouts succeeded (empty set is allowed).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeAttempt, WorkspaceOrchestration } from "@okf-wiki/contract";
import type {
  AgentRunner,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
} from "../../ports/agent-runner.js";
import {
  PLAN_SCOUT_KINDS,
  type PlanScoutKind,
  planScoutPrompt,
} from "../../prompts/plan-scout.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";

export type PlanScoutReceipt = {
  kind: PlanScoutKind;
  /** Bundle-relative path under run workdir (e.g. analysis/plan-scouts/entry.md). */
  relPath: string;
  summary: string;
  ok: boolean;
};

export type RunPlanScoutsInput = {
  layout: RunWorkdirLayoutPaths;
  workspaceName: string;
  runtime: AgentRunner;
  orch: WorkspaceOrchestration;
  operatorNotes?: string;
  /** Prefer worker (cheap); fall back to planner. */
  model?: unknown;
  modelRuntime?: unknown;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  sourceIgnores?: SourceIgnoreInput;
  abortSignal?: AbortSignal;
  onProgress?: (attempt: NodeAttempt) => void;
  /** Round index for graph attempts (0 = first plan). */
  runIndex?: number;
};

export type RunPlanScoutsResult = {
  receipts: PlanScoutReceipt[];
  /** Text block injected into the planner task. */
  plannerContext: string;
};

function selectScoutKinds(count: number): PlanScoutKind[] {
  const n = Math.max(0, Math.min(count, PLAN_SCOUT_KINDS.length));
  return PLAN_SCOUT_KINDS.slice(0, n);
}

/**
 * Run plan scouts when orchestration.planScoutCount > 0 and runtime is live.
 * Fixture / zero count → empty receipts (caller uses single planner only).
 */
export async function runPlanScouts(input: RunPlanScoutsInput): Promise<RunPlanScoutsResult> {
  const count = Math.max(0, input.orch.planScoutCount ?? 0);
  if (count === 0 || input.runtime.kind === "fixture") {
    return { receipts: [], plannerContext: "" };
  }

  const kinds = selectScoutKinds(count);
  const concurrency = Math.max(
    1,
    Math.min(kinds.length, input.orch.planScoutConcurrency ?? kinds.length),
  );
  const runIndex = input.runIndex ?? 0;
  const scoutsDir = path.join(input.layout.analysisDir, "plan-scouts");
  await mkdir(scoutsDir, { recursive: true });

  const receipts = await mapWithConcurrency(
    kinds,
    concurrency,
    input.abortSignal,
    async (kind) => {
      const attemptId = `plan@${runIndex}:scout-${kind}`;
      const relPath = `analysis/plan-scouts/${kind}.md`;
      try {
        const child = await input.runtime.runAgent({
          role: "root_research",
          spanId: attemptId,
          nodeKey: "plan",
          runIndex,
          runWorkDir: input.layout.runWorkDir,
          task: planScoutPrompt({
            kind,
            workspaceName: input.workspaceName,
            operatorNotes: input.operatorNotes,
          }),
          systemPrompt:
            "You are a read-only plan scout. Inspect sources/ and return a compact structured report. Do not write wiki pages.",
          preferFinalMessage: false,
          model: input.model,
          modelRuntime: input.modelRuntime,
          maxContextTokens: input.maxContextTokens,
          contextTargetTokens: input.contextTargetTokens,
          sourceIgnores: input.sourceIgnores,
          abortSignal: input.abortSignal,
          onProgress: input.onProgress,
        });
        const body = [
          `# Plan scout: ${kind}`,
          "",
          child.summary?.trim() || "(empty scout summary)",
          "",
        ].join("\n");
        await writeFile(path.join(input.layout.runWorkDir, relPath), body, "utf8");
        return {
          kind,
          relPath,
          summary: (child.summary ?? "").slice(0, 4000),
          ok: true,
        } satisfies PlanScoutReceipt;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        const message = err instanceof Error ? err.message : String(err);
        const body = [`# Plan scout: ${kind}`, "", `Scout failed: ${message}`, ""].join("\n");
        await writeFile(path.join(input.layout.runWorkDir, relPath), body, "utf8");
        input.onProgress?.({
          attemptId,
          nodeKey: "plan",
          runIndex,
          role: "root_research",
          status: "error",
          summary: `scout ${kind} failed: ${message}`.slice(0, 4000),
        });
        return {
          kind,
          relPath,
          summary: message.slice(0, 4000),
          ok: false,
        } satisfies PlanScoutReceipt;
      }
    },
  );

  const okReceipts = receipts.filter((r) => r.ok);
  const plannerContext =
    okReceipts.length === 0
      ? ""
      : [
          "Plan scout receipts (multi-angle source survey — synthesize into ONE WikiRunSpec):",
          ...okReceipts.map(
            (r) =>
              `### Scout ${r.kind} (${r.relPath})\n${r.summary.slice(0, 2500)}`,
          ),
          "",
          "Use scout findings as evidence. Resolve conflicts explicitly in openQuestions.",
          "You remain the sole author of the WikiRunSpec — scouts do not submit specs.",
        ].join("\n\n");

  return { receipts, plannerContext };
}
