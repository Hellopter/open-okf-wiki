/**
 * Pi boundary for one disposable WikiRuns attempt.
 *
 * Thin dispatch + wiring only. Materialisation, classification, and per-kind
 * handlers live under runtime/attempt/. This module owns the public factory
 * `createPiAttemptExecutor` that server and workflow depend on.
 *
 * WikiRuns owns claiming, sealing, gates, and publication; keeping those out
 * of this adapter makes an interrupted Pi session safe to discard.
 */

import {
  type AttemptMetrics,
  type PiAttemptExecutor,
  type PiAttemptInput,
  PiAttemptInputSchema,
  type PiAttemptOutcome,
  PiAttemptOutcomeSchema,
} from "@okf-wiki/contract";
import { isPathInside } from "@okf-wiki/core";
import type { AgentRunner } from "../ports/agent-runner.js";
import { classifyPiFailureClass, failure } from "./attempt/classify.js";

/** Re-export the sole attempt-edge classifier for tests and callers. */
export { classifyPiFailureClass, failure };

import { handleFreeze } from "./attempt/handlers/freeze.js";
import { handlePlan } from "./attempt/handlers/plan.js";
import { handleRepair } from "./attempt/handlers/repair.js";
import { handleResearchDomain, handleResearchLeaf } from "./attempt/handlers/research.js";
import { handleReviewSeat } from "./attempt/handlers/review.js";
import { handleWriteRoot } from "./attempt/handlers/write.js";
import { materializeInputs } from "./attempt/materialize.js";
import {
  type AttemptHandlerContext,
  type ResolvePiModel,
  sourceIgnores,
} from "./attempt/shared.js";
import { finalizeAttemptTranscript } from "./attempt-transcript-sink.js";
import { createFixtureProduceRuntime } from "./fixture-runner.js";
import { resolveWorkspacePiModel } from "./model/provider-model.js";
import { createLiveProduceRuntime } from "./scoped-runner.js";

export type CreatePiAttemptExecutorOptions = {
  /** Explicit offline path for tests and local fixture runs. */
  fixture?: boolean;
  /** Inject the runner for focused tests; production uses Pi's live runtime. */
  runtime?: AgentRunner;
  /** Inject provider resolution without exposing credentials through the attempt contract. */
  resolveModel?: ResolvePiModel;
};

export type { PiAttemptExecutor };

/** Graph role for metrics attribution (mirrors workflow graphRoleForNodeKind). */
function graphRoleForKind(kind: string): string {
  switch (kind) {
    case "plan":
      return "plan";
    case "research.leaf":
      return "leaf";
    case "research.domain":
      return "domain";
    case "write.root":
      return "writer";
    case "review.seat":
      return "review";
    case "repair":
      return "repair";
    case "freeze":
      return "mechanical";
    default:
      return kind.slice(0, 64) || "unknown";
  }
}

/**
 * Attach best-effort observation metrics without blocking on missing token counts.
 * Executor-supplied metrics win; defaults fill role / wall_time / stop_reason / model_id.
 */
function withAttemptMetrics(
  outcome: PiAttemptOutcome,
  defaults: {
    role: string;
    wallTimeMs: number;
    modelId?: string;
    stopReason: string;
  },
): PiAttemptOutcome {
  const existing =
    "metrics" in outcome && outcome.metrics && typeof outcome.metrics === "object"
      ? (outcome.metrics as AttemptMetrics)
      : undefined;
  const metrics: AttemptMetrics = {
    ...(existing ?? {}),
  };
  if (metrics.role === undefined) metrics.role = defaults.role;
  if (metrics.wallTimeMs === undefined) metrics.wallTimeMs = defaults.wallTimeMs;
  if (metrics.stopReason === undefined) metrics.stopReason = defaults.stopReason;
  if (metrics.modelId === undefined && defaults.modelId) metrics.modelId = defaults.modelId;
  const merged = { ...outcome, metrics };
  const parsed = PiAttemptOutcomeSchema.safeParse(merged);
  return parsed.success ? parsed.data : outcome;
}

/**
 * Create the concrete Pi executor used by WikiRuns.  It does not read or write
 * WikiRuns state; all returned files remain unsealed Attempt output.
 */
export function createPiAttemptExecutor(
  options: CreatePiAttemptExecutorOptions = {},
): PiAttemptExecutor {
  const runtime =
    options.runtime ??
    (options.fixture ? createFixtureProduceRuntime() : createLiveProduceRuntime());
  const resolveModel = options.resolveModel ?? resolveWorkspacePiModel;

  return async (rawInput, signal) => {
    let input: PiAttemptInput | undefined;
    const startedMs = Date.now();
    try {
      input = PiAttemptInputSchema.parse(rawInput);
      if (signal.aborted)
        throw Object.assign(new Error("Pi attempt cancelled"), { name: "AbortError" });
      const layout = await materializeInputs(input);
      const ignores = sourceIgnores(input);
      const ctx: AttemptHandlerContext = {
        input,
        layout,
        ignores,
        runtime,
        resolveModel,
        signal,
      };

      let outcome: PiAttemptOutcome;
      switch (input.node.kind) {
        case "freeze":
          outcome = await handleFreeze(ctx);
          break;
        case "plan":
          outcome = await handlePlan(ctx);
          break;
        case "write.root":
          outcome = await handleWriteRoot(ctx);
          break;
        case "research.leaf":
          outcome = await handleResearchLeaf(ctx);
          break;
        case "research.domain":
          outcome = await handleResearchDomain(ctx);
          break;
        case "review.seat":
          outcome = await handleReviewSeat(ctx);
          break;
        case "repair":
          outcome = await handleRepair(ctx);
          break;
        default:
          throw new Error(
            `unsupported Pi attempt node: ${(input.node as { kind: string }).kind}/${(input.node as { key: string }).key}`,
          );
      }
      const stopReason =
        outcome.type === "succeeded"
          ? "succeeded"
          : outcome.type === "failed"
            ? outcome.failureClass
            : "gate_requested";
      return withAttemptMetrics(outcome, {
        role: graphRoleForKind(input.node.kind),
        wallTimeMs: Math.max(0, Date.now() - startedMs),
        modelId: input.workspace.model?.id,
        stopReason,
      });
    } catch (error) {
      const outcome = failure(error, signal);
      // Best-effort: leave a readable session transcript for the transcript API
      // even when the attempt fails or is cancelled. Prefer appending over wipe
      // when live JSONL already exists — sealTranscript rebuilds from summary.
      if (input && outcome.type === "failed") {
        try {
          if (!isPathInside(input.attemptDir, input.sessionPath)) {
            throw new Error("session path escaped attempt");
          }
          // Preserve any live JSONL already written by the scoped agent sink.
          await finalizeAttemptTranscript(input.sessionPath, {
            summary: outcome.error,
            terminal: outcome.failureClass === "cancelled" ? "cancelled" : "error",
            preserveExisting: true,
            meta: {
              node: input.node.key,
              attemptId: input.attemptId,
              mode: "failed",
              failureClass: outcome.failureClass,
              error: outcome.error,
            },
          });
        } catch {
          // ignore transcript write errors on the failure path
        }
      }
      return withAttemptMetrics(outcome, {
        role: input ? graphRoleForKind(input.node.kind) : "unknown",
        wallTimeMs: Math.max(0, Date.now() - startedMs),
        modelId: input?.workspace.model?.id,
        stopReason: outcome.type === "failed" ? outcome.failureClass : "failed",
      });
    }
  };
}
