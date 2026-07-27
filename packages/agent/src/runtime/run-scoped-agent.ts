/**
 * Unified in-process Pi child runner (SDK embed — not pi CLI spawn).
 *
 * Aligns with Pi's subagent *pattern* (parent tool details projection, isolated
 * context) while keeping ADR 0030/0032 product constraints: SessionManager.inMemory,
 * noExtensions, no bash, children never write Operator Session JSONL.
 *
 * Live only. Fixture short-circuits belong on AgentRunner adapters.
 * Event → attempt projection lives in runtime/projectors/attempt-projector (pure).
 *
 * Boundary: callers must supply systemPrompt (no role defaults) and preferFinalMessage.
 * Pages listing / empty-write fail-closed lives on writeWiki adapters, not here.
 * Plan Spec handoff is disk-only (analysis/plan-draft.json) — no tool-result scrape.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NodeAttempt } from "@okf-wiki/contract";
import { createWikiSession, type WikiSessionHandle } from "./create-wiki-session.js";
import type { SourceIgnoreInput } from "./path-policy.js";
import { resolveAssistantSummary } from "./projectors/assistant-outcome.js";
import {
  applyAttemptSessionEvent,
  attemptItemsSnapshot,
  createAttemptProjectorState,
} from "./projectors/attempt-projector.js";
import type { WikiAgentRole } from "./tool-policy.js";

export type ScopedAgentRole = Extract<
  WikiAgentRole,
  "domain" | "leaf" | "reviewer" | "root_research" | "plan" | "root_write"
>;

/** Live progress for one scoped loop — maps 1:1 to a NodeAttempt on the Run Graph. */
export type ScopedAgentProgress = NodeAttempt;

export type RunScopedAgentInput = {
  role: ScopedAgentRole;
  runWorkDir: string;
  task: string;
  /** Required for live sessions — no role-based runtime defaults. */
  systemPrompt?: string;
  /**
   * Prefer last assistant message over streamed text for the control summary.
   * Required to match AgentRunRequest: plan/reviewer true; research/scouts false.
   */
  preferFinalMessage: boolean;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  additionalSkillPaths?: readonly string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Unique attempt id for this scoped loop (streaming upserts share the same id).
   * Defaults to role when omitted.
   */
  spanId?: string;
  /**
   * Topology node this attempt belongs to. Defaults to spanId/role when omitted.
   * Multi-member roles (review council) share one nodeKey and differ by spanId/runIndex.
   */
  nodeKey?: string;
  /** Round / retry index for the topology node (0-based). Defaults to 0. */
  runIndex?: number;
  /**
   * Extra Pi customTools (merged by name over Operations-scoped tools).
   * Plan role must pass submit_wiki_run_spec here — runner does not inject by role.
   */
  customTools?: ToolDefinition<any, any>[];
  onProgress?: (span: ScopedAgentProgress) => void;
};

export type RunScopedAgentResult = {
  role: ScopedAgentRole;
  summary: string;
  mode: "live";
  receiptPath?: string;
  /** Set by runScopedAgentsParallel when this task failed (summary holds the error). */
  failed?: boolean;
};

/** Control-plane summaries stay short (UI + parent handle). Full Spec lives on disk. */
const SUMMARY_RETURN_CAP = 4_000;

function controlSummary(text: string, max = SUMMARY_RETURN_CAP): string {
  return truncate(text.trim(), max);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function emitProgress(
  onProgress: RunScopedAgentInput["onProgress"],
  span: ScopedAgentProgress,
): void {
  try {
    onProgress?.(span);
  } catch {
    // Display must not break the child run.
  }
}

function abortError(): Error {
  const err = new Error("Wiki Run cancelled");
  err.name = "AbortError";
  return err;
}

/**
 * Run one role-scoped in-process Pi AgentSession.
 * Always uses role allowlist (no bash). Never attaches parent SessionManager.
 */
export async function runScopedAgent(input: RunScopedAgentInput): Promise<RunScopedAgentResult> {
  const attemptId = input.spanId?.trim() || input.role;
  const nodeKey = input.nodeKey?.trim() || attemptId;
  const runIndex = input.runIndex ?? 0;
  const role = input.role;

  if (input.abortSignal?.aborted) {
    emitProgress(input.onProgress, {
      attemptId,
      nodeKey,
      runIndex,
      role,
      status: "cancelled",
      summary: "Wiki Run cancelled",
    });
    throw abortError();
  }

  if (!input.model) {
    throw new Error(
      `Scoped agent (${input.role}) live mode requires a model, or use FixtureProduceRuntime / fixture: true for smoke only`,
    );
  }

  const systemPrompt = input.systemPrompt?.trim();
  if (!systemPrompt) {
    throw new Error(
      `Scoped agent (${input.role}) requires systemPrompt — no runtime role defaults (callers must pass an explicit prompt)`,
    );
  }

  const sessionRole: WikiAgentRole = role;
  let handle: WikiSessionHandle | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const onAbort = () => {
    try {
      handle?.session.abort();
    } catch {
      // best-effort
    }
  };
  const onTimeout = () => {
    timedOut = true;
    onAbort();
  };

  const projector = createAttemptProjectorState();

  const snapshot = (
    status: ScopedAgentProgress["status"],
    summary?: string,
  ): ScopedAgentProgress => {
    const items = attemptItemsSnapshot(projector);
    return {
      attemptId,
      nodeKey,
      runIndex,
      role,
      status,
      ...(summary ? { summary: truncate(summary, 4000) } : {}),
      ...(items ? { items } : {}),
      usage: {
        turns: projector.turns,
        ...(projector.contextTokens !== undefined
          ? { contextTokens: projector.contextTokens }
          : {}),
      },
    };
  };

  try {
    emitProgress(input.onProgress, snapshot("running", `${input.role} started`));

    handle = await createWikiSession({
      role: sessionRole,
      runWorkDir: input.runWorkDir,
      model: input.model,
      modelRuntime: input.modelRuntime,
      systemPrompt,
      sourceIgnores: input.sourceIgnores,
      maxContextTokens: input.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      additionalSkillPaths: input.additionalSkillPaths,
      scopedTools: true,
      customTools: input.customTools,
    });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        onAbort();
        emitProgress(input.onProgress, snapshot("cancelled", "Wiki Run cancelled"));
        throw abortError();
      }
      input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutId = setTimeout(onTimeout, input.timeoutMs);
    }

    const unsub = handle.session.subscribe((event) => {
      applyAttemptSessionEvent(projector, event);
      emitProgress(input.onProgress, snapshot("running"));
    });

    try {
      await handle.session.prompt(input.task);
    } finally {
      unsub();
    }

    // Timeout is a budget failure, not an operator cancellation — surface it
    // as a distinct error so the run records `failed`, never `cancelled`.
    if (timedOut) {
      const message = `Scoped agent (${input.role}) timed out after ${input.timeoutMs} ms (workspace request timeout)`;
      emitProgress(input.onProgress, snapshot("error", message));
      throw new Error(message);
    }

    if (input.abortSignal?.aborted) {
      emitProgress(input.onProgress, snapshot("cancelled", "Wiki Run cancelled"));
      throw abortError();
    }

    const resolved = resolveAssistantSummary({
      streamedText: projector.streamedText,
      messages: handle.session.messages,
      roleLabel: input.role,
      preferFinalMessage: input.preferFinalMessage,
    });
    if (resolved.isError) {
      emitProgress(input.onProgress, snapshot("error", resolved.errorMessage ?? resolved.summary));
      throw new Error(
        `Scoped agent (${input.role}) failed: ${resolved.errorMessage ?? resolved.summary}`,
      );
    }

    const summary = controlSummary(resolved.summary);
    emitProgress(input.onProgress, snapshot("done", summary));
    return {
      role: input.role,
      mode: "live",
      summary,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    const message = err instanceof Error ? err.message : String(err);
    emitProgress(input.onProgress, snapshot("error", message));
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (input.abortSignal) {
      input.abortSignal.removeEventListener("abort", onAbort);
    }
    handle?.dispose();
  }
}

/**
 * Fan-out helper with concurrency cap (product delegation limits).
 *
 * Per-task settle semantics: a non-abort task failure yields a result with
 * `failed: true` (summary carries the error) instead of rejecting the batch,
 * so one bad leaf never discards its siblings' completed work. AbortError
 * still rejects the whole batch (cancellation).
 */
export async function runScopedAgentsParallel(
  tasks: RunScopedAgentInput[],
  opts?: { concurrency?: number },
): Promise<RunScopedAgentResult[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? 2);
  const results: RunScopedAgentResult[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i]!;
      try {
        results[i] = await runScopedAgent(task);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        const message = err instanceof Error ? err.message : String(err);
        results[i] = {
          role: task.role,
          summary: `FAILED: ${message}`,
          mode: "live",
          failed: true,
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
