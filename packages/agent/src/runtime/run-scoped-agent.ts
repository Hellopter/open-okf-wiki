/**
 * Unified in-process Pi child runner (SDK embed — not pi CLI spawn).
 *
 * Aligns with Pi's subagent *pattern* (parent tool details projection, isolated
 * context) while keeping ADR 0030/0032 product constraints: SessionManager.inMemory,
 * noExtensions, no bash, children never write Operator Session JSONL.
 *
 * Live only. Fixture short-circuits belong on AgentRunner adapters.
 * Event → attempt projection lives in runtime/projectors/attempt-projector (pure).
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NodeAttempt } from "@okf-wiki/contract";
import { SUBMIT_WIKI_RUN_SPEC_TOOL_NAME } from "@okf-wiki/contract";
import { listWikiMarkdown } from "../produce/wiki-pages.js";
import { createWikiSession, type WikiSessionHandle } from "./create-wiki-session.js";
import type { SourceIgnoreInput } from "./fs-operations.js";
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
  /** Caller-supplied system prompt; minimal role default used only when omitted. */
  systemPrompt?: string;
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
  /** When set (root_write), list pages under this wiki dir after success. */
  wikiDir?: string;
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
  pages?: string[];
  receiptPath?: string;
  /** Path-first plan handoff (relative under run workdir). */
  specPath?: string;
  /** Set by runScopedAgentsParallel when this task failed (summary holds the error). */
  failed?: boolean;
};

/** Control-plane summaries stay short (UI + parent handle). Full Spec lives on disk. */
const SUMMARY_RETURN_CAP = 4_000;

function controlSummary(text: string, max = SUMMARY_RETURN_CAP): string {
  return truncate(text.trim(), max);
}

/** Prefer last assistant message for roles that may still spill structured text. */
function isStructuredReturnRole(role: ScopedAgentRole): boolean {
  return role === "plan" || role === "reviewer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function defaultSystemPrompt(role: ScopedAgentRole): string | undefined {
  if (role === "root_write") return undefined;
  if (role === "plan") {
    return (
      `You are the Wiki planner. Use read tools only, then call ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} ` +
      "with a complete WikiRunSpec."
    );
  }
  if (role === "reviewer") {
    return "You are a wiki reviewer. Return a concise DefectReport JSON (or NO_DEFECTS).";
  }
  return `You are a ${role} researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.`;
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
  let submittedSpecPath: string | undefined;

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
      systemPrompt: input.systemPrompt ?? defaultSystemPrompt(role),
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

      // Path-first plan handoff: capture specPath from successful submit tool end.
      if (isRecord(event) && event.type === "tool_execution_end" && event.isError !== true) {
        const name = typeof event.toolName === "string" ? event.toolName : "";
        if (name === SUBMIT_WIKI_RUN_SPEC_TOOL_NAME) {
          const result = isRecord(event.result) ? event.result : null;
          const details = result && isRecord(result.details) ? result.details : null;
          const pathFromDetails =
            details && typeof details.specPath === "string" ? details.specPath.trim() : "";
          if (pathFromDetails) submittedSpecPath = pathFromDetails;
        }
      }

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
      preferFinalMessage: isStructuredReturnRole(role),
    });
    if (resolved.isError) {
      emitProgress(input.onProgress, snapshot("error", resolved.errorMessage ?? resolved.summary));
      throw new Error(
        `Scoped agent (${input.role}) failed: ${resolved.errorMessage ?? resolved.summary}`,
      );
    }

    let pages: string[] | undefined;
    if (role === "root_write" && input.wikiDir) {
      pages = await listWikiMarkdown(input.wikiDir);
      if (pages.length === 0) {
        emitProgress(input.onProgress, snapshot("error", "No wiki markdown pages written"));
        throw new Error("Pi live produce finished without writing any wiki markdown pages");
      }
    }

    // Path-first: when plan draft was submitted, control summary is a short ACK only.
    // Full WikiRunSpec lives in analysis/plan-draft.json — never re-embed it here.
    const summary = controlSummary(
      pages
        ? `Pi live produce wrote ${pages.length} page(s)`
        : role === "plan" && submittedSpecPath
          ? `Plan submitted → ${submittedSpecPath}`
          : resolved.summary,
    );
    emitProgress(input.onProgress, snapshot("done", summary));
    return {
      role: input.role,
      mode: "live",
      summary,
      ...(pages ? { pages } : {}),
      ...(submittedSpecPath ? { specPath: submittedSpecPath } : {}),
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
