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
import type { AttemptItem, NodeAttempt, RetryLimits } from "@okf-wiki/contract";
import type { AgentRunRequest, ScopedRunnerRole } from "../ports/agent-runner.js";
import { classifyAgentFailure } from "../workflow/retry-policy.js";
import {
  createAttemptTranscriptSink,
  type AttemptTranscriptSink,
} from "./attempt-transcript-sink.js";
import {
  createWikiSession,
  type WikiSessionHandle,
  type WikiSessionRetryInput,
} from "./create-wiki-session.js";
import type { SourceIgnoreInput } from "./path-policy.js";
import { resolveAssistantSummary } from "./projectors/assistant-outcome.js";
import {
  applyAttemptSessionEvent,
  attemptItemsSnapshot,
  createAttemptProjectorState,
} from "./projectors/attempt-projector.js";
import type { WikiAgentRole } from "./tool-policy.js";

/**
 * Single role type for scoped runners (port + live runtime).
 * Alias of port ScopedRunnerRole — ports stay free of Pi SDK / tool-policy imports.
 */
export type ScopedAgentRole = ScopedRunnerRole;

/** Live progress for one scoped loop — maps 1:1 to a NodeAttempt on the Run Graph. */
export type ScopedAgentProgress = NodeAttempt;

/** Context / prompt capacity exhausted (overflow, oversized task). */
export class CapacityError extends Error {
  readonly errorClass = "capacity" as const;
  name = "CapacityError";
}

/** Wall-clock or token budget exhausted (timeout, budget caps). */
export class BudgetError extends Error {
  readonly errorClass = "budget" as const;
  name = "BudgetError";
}

/** Host / runtime infrastructure failure. */
export class InfrastructureError extends Error {
  readonly errorClass = "infrastructure" as const;
  name = "InfrastructureError";
}

/** Rough char gate before tokenization — oversized tasks fail closed as capacity. */
const TASK_CHAR_CAPACITY_GATE = 500_000;

/**
 * Live runtime input: AgentRunRequest field list with Pi-concrete overrides at the
 * adapter boundary (model/runtime/tools/sourceIgnores). Ports keep those as unknown.
 */
export type RunScopedAgentInput = Omit<
  AgentRunRequest,
  "model" | "modelRuntime" | "sourceIgnores" | "customTools" | "retry" | "onProgress"
> & {
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  sourceIgnores?: SourceIgnoreInput;
  /**
   * Extra Pi customTools (merged by name over Operations-scoped tools).
   * Plan role must pass submit_wiki_run_spec here — runner does not inject by role.
   */
  customTools?: ToolDefinition<any, any>[];
  /** Pi auto-retry policy (workspace.limits.retry) or session-shaped override. */
  retry?: WikiSessionRetryInput | RetryLimits;
  onProgress?: (span: ScopedAgentProgress) => void;
};

export type RunScopedAgentResult = {
  role: ScopedAgentRole;
  summary: string;
  mode: "live";
  receiptPath?: string;
  /** Final projector items (tool/text trail) for callers that seal transcripts. */
  items?: AttemptItem[];
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
 * Best-effort detection of context-window overflow / compact exhaustion.
 * Routes through shared `classifyAgentFailure` so capacity patterns stay single-sourced.
 */
function looksLikeContextOverflow(message: string): boolean {
  return classifyAgentFailure(message) === "capacity";
}

/**
 * Fold auto-retry / compaction session events into a short progress note.
 * Best-effort: unknown event shapes are ignored.
 */
function progressNoteFromSessionEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || !("type" in event)) return undefined;
  const type = (event as { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  if (type === "auto_retry_start") {
    const attempt = (event as { attempt?: unknown }).attempt;
    const maxAttempts = (event as { maxAttempts?: unknown }).maxAttempts;
    if (typeof attempt === "number" && typeof maxAttempts === "number") {
      return `auto-retry ${attempt}/${maxAttempts}`;
    }
    return "auto-retry…";
  }
  if (type === "auto_retry_end") {
    const success = (event as { success?: unknown }).success;
    return success === true ? "auto-retry ok" : "auto-retry failed";
  }
  if (type === "compaction_end") {
    const aborted = (event as { aborted?: unknown }).aborted;
    return aborted === true ? "compaction aborted" : "compaction done";
  }
  return undefined;
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

  if (typeof input.task === "string" && input.task.length > TASK_CHAR_CAPACITY_GATE) {
    const message = `Scoped agent (${input.role}) task exceeds capacity gate (${input.task.length} chars > ${TASK_CHAR_CAPACITY_GATE})`;
    emitProgress(input.onProgress, {
      attemptId,
      nodeKey,
      runIndex,
      role,
      status: "error",
      summary: message,
      errorClass: "capacity",
    });
    throw new CapacityError(message);
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
  const sink: AttemptTranscriptSink | undefined = input.transcriptPath
    ? createAttemptTranscriptSink(input.transcriptPath)
    : undefined;

  const flushTranscript = (
    status: ScopedAgentProgress["status"],
    summary?: string,
  ): void => {
    if (!sink) return;
    const items = attemptItemsSnapshot(projector);
    const terminal =
      status === "done"
        ? "done"
        : status === "error"
          ? "error"
          : status === "cancelled"
            ? "cancelled"
            : undefined;
    // Fire-and-forget; sink serializes writes. Failures must not kill the agent.
    void sink
      .writeProgress({
        task: input.task,
        items,
        summary,
        terminal,
      })
      .catch(() => undefined);
  };

  const snapshot = (
    status: ScopedAgentProgress["status"],
    summary?: string,
  ): ScopedAgentProgress => {
    const items = attemptItemsSnapshot(projector);
    flushTranscript(status, summary);
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
      retry: input.retry,
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
      const note = progressNoteFromSessionEvent(event);
      emitProgress(input.onProgress, snapshot("running", note));
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
      throw new BudgetError(message);
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
      const detail = resolved.errorMessage ?? resolved.summary;
      emitProgress(input.onProgress, snapshot("error", detail));
      const message = `Scoped agent (${input.role}) failed: ${detail}`;
      if (looksLikeContextOverflow(detail) || looksLikeContextOverflow(message)) {
        throw new CapacityError(message);
      }
      throw new Error(message);
    }

    const summary = controlSummary(resolved.summary);
    emitProgress(input.onProgress, snapshot("done", summary));
    const items = attemptItemsSnapshot(projector);
    return {
      role: input.role,
      mode: "live",
      summary,
      ...(items ? { items } : {}),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      flushTranscript("cancelled", "Wiki Run cancelled");
      throw err;
    }
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
