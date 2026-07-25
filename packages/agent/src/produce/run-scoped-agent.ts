/**
 * Unified in-process Pi child runner (SDK embed — not pi CLI spawn).
 *
 * Aligns with Pi's subagent *pattern* (parent tool details projection, isolated
 * context) while keeping ADR 0030/0032 product constraints: SessionManager.inMemory,
 * noExtensions, no bash, children never write Operator Session JSONL.
 *
 * Live only. Fixture short-circuits belong on ProduceRuntime adapters.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WikiProduceChildItem, WikiProduceChildSpan } from "@okf-wiki/contract";
import { resolveAssistantSummary } from "../pi/assistant-outcome.js";
import { createWikiSession, type WikiSessionHandle } from "../pi/create-wiki-session.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import type { WikiAgentRole } from "../pi/tool-policy.js";
import {
  createSubmitWikiRunSpecTool,
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
} from "./submit-wiki-run-spec-tool.js";
import { listWikiMarkdown } from "./wiki-pages.js";

export type ScopedAgentRole = Extract<
  WikiAgentRole,
  "domain" | "leaf" | "reviewer" | "root_research" | "plan" | "root_write"
>;

export type ScopedAgentProgress = WikiProduceChildSpan;

export type RunScopedAgentInput = {
  role: ScopedAgentRole;
  runWorkDir: string;
  task: string;
  systemPrompt?: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  additionalSkillPaths?: readonly string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  spanId?: string;
  /** When set (root_write), list pages under this wiki dir after success. */
  wikiDir?: string;
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
};

const MAX_ITEMS = 20;
const MAX_TEXT_CHUNK = 2000;
const MAX_ARGS_SUMMARY = 500;
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

function argsSummary(args: unknown): string | undefined {
  if (args == null) return undefined;
  try {
    const raw = typeof args === "string" ? args : JSON.stringify(args);
    return truncate(raw, MAX_ARGS_SUMMARY);
  } catch {
    return undefined;
  }
}

function pushItem(items: WikiProduceChildItem[], item: WikiProduceChildItem): void {
  if (item.type === "text" && items.length > 0) {
    const last = items[items.length - 1];
    if (last?.type === "text") {
      items[items.length - 1] = {
        type: "text",
        text: truncate(last.text + item.text, MAX_TEXT_CHUNK * 2),
      };
      return;
    }
  }
  items.push(item);
  while (items.length > MAX_ITEMS) items.shift();
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
  const spanId = input.spanId?.trim() || input.role;
  const role = input.role;

  if (input.abortSignal?.aborted) {
    emitProgress(input.onProgress, {
      id: spanId,
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
  const onAbort = () => {
    try {
      handle?.session.abort();
    } catch {
      // best-effort
    }
  };

  const items: WikiProduceChildItem[] = [];
  let turns = 0;
  let contextTokens: number | undefined;
  let submittedSpecPath: string | undefined;

  const snapshot = (
    status: ScopedAgentProgress["status"],
    summary?: string,
  ): ScopedAgentProgress => ({
    id: spanId,
    role,
    status,
    ...(summary ? { summary: truncate(summary, 4000) } : {}),
    ...(items.length > 0 ? { items: items.slice(-MAX_ITEMS) } : {}),
    usage: {
      turns,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
    },
  });

  try {
    emitProgress(input.onProgress, snapshot("running", `${input.role} started`));

    const planTools =
      role === "plan" ? [createSubmitWikiRunSpecTool({ runWorkDir: input.runWorkDir })] : [];

    handle = await createWikiSession({
      role: sessionRole,
      runWorkDir: input.runWorkDir,
      model: input.model,
      modelRuntime: input.modelRuntime,
      systemPrompt:
        input.systemPrompt ??
        (role === "root_write"
          ? undefined
          : role === "plan"
            ? `You are the Wiki planner. Use read tools only, then call ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} with a complete WikiRunSpec.`
            : `You are a ${input.role} researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.`),
      sourceIgnores: input.sourceIgnores,
      maxContextTokens: input.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      additionalSkillPaths: input.additionalSkillPaths,
      scopedTools: true,
      customTools: planTools,
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
      timeoutId = setTimeout(onAbort, input.timeoutMs);
    }

    let text = "";
    const unsub = handle.session.subscribe((event) => {
      const kind =
        event && typeof event === "object" && "type" in event
          ? String((event as { type: unknown }).type)
          : "event";
      const raw = event as unknown;
      if (!isRecord(raw)) return;

      if (kind === "message_update") {
        const ame = isRecord(raw.assistantMessageEvent) ? raw.assistantMessageEvent : null;
        if (!ame) return;
        if (ame.type === "text_delta" && typeof ame.delta === "string") {
          text += ame.delta;
          pushItem(items, { type: "text", text: truncate(ame.delta, MAX_TEXT_CHUNK) });
          emitProgress(input.onProgress, snapshot("running"));
        }
        return;
      }

      if (kind === "message_end") {
        const message = isRecord(raw.message) ? raw.message : null;
        if (message && message.role === "assistant") {
          turns += 1;
          if (isRecord(message.usage)) {
            const total = message.usage.totalTokens;
            if (typeof total === "number" && total >= 0) contextTokens = total;
          }
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (!isRecord(block) || block.type !== "toolCall") continue;
              const name = typeof block.name === "string" ? block.name : "tool";
              const args = "arguments" in block ? block.arguments : block.args;
              pushItem(items, {
                type: "toolCall",
                name,
                argsSummary: argsSummary(args),
                status: "running",
              });
            }
          }
          emitProgress(input.onProgress, snapshot("running"));
        }
        return;
      }

      if (kind === "tool_execution_start") {
        const name = typeof raw.toolName === "string" ? raw.toolName : "tool";
        pushItem(items, {
          type: "toolCall",
          name,
          argsSummary: argsSummary(raw.args ?? raw.input),
          status: "running",
        });
        emitProgress(input.onProgress, snapshot("running"));
        return;
      }

      if (kind === "tool_execution_end") {
        const name = typeof raw.toolName === "string" ? raw.toolName : "tool";
        const isError = raw.isError === true;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it?.type === "toolCall" && it.name === name && it.status === "running") {
            items[i] = { ...it, status: isError ? "error" : "done" };
            break;
          }
        }
        if (!isError && name === SUBMIT_WIKI_RUN_SPEC_TOOL_NAME) {
          const result = isRecord(raw.result) ? raw.result : null;
          const details = result && isRecord(result.details) ? result.details : null;
          const pathFromDetails =
            details && typeof details.specPath === "string" ? details.specPath.trim() : "";
          if (pathFromDetails) submittedSpecPath = pathFromDetails;
        }
        emitProgress(input.onProgress, snapshot("running"));
      }
    });

    try {
      await handle.session.prompt(input.task);
    } finally {
      unsub();
    }

    if (input.abortSignal?.aborted) {
      emitProgress(input.onProgress, snapshot("cancelled", "Wiki Run cancelled"));
      throw abortError();
    }

    const resolved = resolveAssistantSummary({
      streamedText: text,
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

/** Fan-out helper with concurrency cap (product delegation limits). */
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
      results[i] = await runScopedAgent(tasks[i]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
