/**
 * Append-only, secret-free Attempt trace writer for Node details.
 *
 * AttemptItem is deliberately a small live projection. This JSONL trace is the
 * audit record and never rewrites prior rows. The trace stops with an explicit
 * marker at 2 MiB rather than silently replacing or clipping its history.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AttemptItem, AttemptTraceEvent } from "@okf-wiki/contract/wiki-runs";
import { formatToolResultText } from "@okf-wiki/contract/stream-server";
import { redactSensitiveText, redactSensitiveValue } from "../redact/index.js";

export const ATTEMPT_TRACE_MAX_BYTES = 2 * 1024 * 1024;
export const ATTEMPT_TRACE_FIELD_MAX_BYTES = 64 * 1024;
const TRACE_CAP_RESERVE_BYTES = 512;
const ASSISTANT_COALESCE_MAX_BYTES = 16 * 1024;

type TraceDraft =
  | { kind: "input"; content: string }
  | { kind: "assistant"; content: string }
  | { kind: "tool_call"; toolCallId?: string; name: string; args?: string }
  | {
      kind: "tool_result";
      toolCallId?: string;
      name: string;
      output?: string;
      status: "done" | "error";
    }
  | { kind: "terminal"; status: "done" | "error" | "cancelled"; summary?: string };

type TraceFileState = {
  bytes: number;
  hasInput: boolean;
  nextOrdinal: number;
  truncated: boolean;
};

export type AttemptTranscriptSink = {
  readonly path: string;
  /** Persist the operator task before any trace event. */
  start(): Promise<void>;
  /** Consume a Pi session event without changing the bounded AttemptItem tail. */
  writeSessionEvent(event: unknown): Promise<void>;
  /** Append terminal evidence without rebuilding the earlier trace. */
  appendTerminal(input: {
    summary?: string;
    terminal: "done" | "error" | "cancelled";
  }): Promise<void>;
  /** Wait for queued writes, including a coalesced assistant text block. */
  flush(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cutUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) <= 0xbf) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Redact first, then make every field-sized truncation visible to operators. */
function boundedTraceText(value: unknown, maxBytes = ATTEMPT_TRACE_FIELD_MAX_BYTES): string {
  let raw: string | undefined;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(redactSensitiveValue(value));
    } catch {
      raw = String(value);
    }
  }
  const text = redactSensitiveText(raw ?? "").trim();
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let kept = cutUtf8(text, Math.max(0, maxBytes - 48));
  let marker = `...[truncated ${text.length - kept.length} chars]`;
  kept = cutUtf8(text, Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8")));
  marker = `...[truncated ${text.length - kept.length} chars]`;
  return `${kept}${marker}`;
}

function toolOutput(value: unknown): string | undefined {
  const output = formatToolResultText(redactSensitiveValue(value), ATTEMPT_TRACE_FIELD_MAX_BYTES);
  return output ? boundedTraceText(output) : undefined;
}

function toolArgs(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedTraceText(value);
}

function stringField(value: unknown, fallback: string, max = 120): string {
  const text = typeof value === "string" ? boundedTraceText(value, max).trim() : "";
  return text || fallback;
}

function traceDraftsFromSessionEvent(event: unknown): TraceDraft[] {
  if (!isRecord(event) || typeof event.type !== "string") return [];

  if (event.type === "tool_execution_start") {
    const args = toolArgs(event.args ?? event.input);
    return [
      {
        kind: "tool_call",
        ...(typeof event.toolCallId === "string" && event.toolCallId.trim()
          ? { toolCallId: event.toolCallId.trim().slice(0, 200) }
          : {}),
        name: stringField(event.toolName, "tool"),
        ...(args ? { args } : {}),
      },
    ];
  }

  if (event.type === "tool_execution_end") {
    const output = toolOutput(event.result ?? event.output);
    return [
      {
        kind: "tool_result",
        ...(typeof event.toolCallId === "string" && event.toolCallId.trim()
          ? { toolCallId: event.toolCallId.trim().slice(0, 200) }
          : {}),
        name: stringField(event.toolName, "tool"),
        ...(output ? { output } : {}),
        status: event.isError === true ? "error" : "done",
      },
    ];
  }

  return [];
}

async function readTraceFileState(filePath: string): Promise<TraceFileState> {
  const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  let nextOrdinal = 1;
  let hasInput = false;
  let truncated = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.trace !== 1 || !Number.isSafeInteger(row.ordinal)) continue;
      nextOrdinal = Math.max(nextOrdinal, Number(row.ordinal) + 1);
      if (row.kind === "input") hasInput = true;
      if (row.kind === "truncated") truncated = true;
    } catch {
      // The reader handles historic/corrupt rows defensively. Do not rewrite them.
    }
  }
  return { bytes: Buffer.byteLength(raw, "utf8"), hasInput, nextOrdinal, truncated };
}

function materializeTraceEvent(state: TraceFileState, draft: TraceDraft): AttemptTraceEvent {
  return {
    trace: 1,
    ordinal: state.nextOrdinal++,
    at: new Date().toISOString(),
    ...draft,
  } as AttemptTraceEvent;
}

async function appendTraceDrafts(
  filePath: string,
  drafts: readonly TraceDraft[],
  initialTask?: string,
): Promise<void> {
  if (drafts.length === 0 && !initialTask?.trim()) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  const state = await readTraceFileState(filePath);
  if (state.truncated || state.bytes >= ATTEMPT_TRACE_MAX_BYTES) return;

  const pending: TraceDraft[] = [];
  if (!state.hasInput && initialTask?.trim()) {
    pending.push({ kind: "input", content: boundedTraceText(initialTask) });
  }
  pending.push(...drafts);

  const lines: string[] = [];
  for (const draft of pending) {
    const row = `${JSON.stringify(materializeTraceEvent(state, draft))}\n`;
    const rowBytes = Buffer.byteLength(row, "utf8");
    if (state.bytes + rowBytes <= ATTEMPT_TRACE_MAX_BYTES - TRACE_CAP_RESERVE_BYTES) {
      lines.push(row);
      state.bytes += rowBytes;
      if (draft.kind === "input") state.hasInput = true;
      continue;
    }

    const marker = `${JSON.stringify({
      trace: 1,
      ordinal: state.nextOrdinal++,
      at: new Date().toISOString(),
      kind: "truncated",
      reason: "trace_limit",
      limitBytes: ATTEMPT_TRACE_MAX_BYTES,
    } satisfies AttemptTraceEvent)}\n`;
    if (state.bytes + Buffer.byteLength(marker, "utf8") <= ATTEMPT_TRACE_MAX_BYTES) {
      lines.push(marker);
    }
    break;
  }
  if (lines.length > 0) await appendFile(filePath, lines.join(""), "utf8");
}

/** Create an append-only trace sink bound to one live Pi Attempt. */
export function createAttemptTranscriptSink(
  sessionPath: string,
  task?: string,
): AttemptTranscriptSink {
  const resolved = path.resolve(sessionPath);
  let chain: Promise<void> = Promise.resolve();
  let pendingAssistantText = "";

  const enqueue = (job: () => Promise<void>): Promise<void> => {
    chain = chain.then(job, job);
    return chain;
  };
  const flushAssistant = async (): Promise<void> => {
    if (!pendingAssistantText) return;
    const text = pendingAssistantText;
    pendingAssistantText = "";
    const drafts: TraceDraft[] = [];
    let rest = text;
    while (rest) {
      const chunk = cutUtf8(rest, ATTEMPT_TRACE_FIELD_MAX_BYTES);
      if (!chunk) break;
      drafts.push({ kind: "assistant", content: boundedTraceText(chunk) });
      rest = rest.slice(chunk.length);
    }
    await appendTraceDrafts(resolved, drafts, task);
  };

  return {
    path: resolved,
    start: () => enqueue(() => appendTraceDrafts(resolved, [], task)),
    writeSessionEvent(event) {
      if (
        isRecord(event) &&
        event.type === "message_update" &&
        isRecord(event.assistantMessageEvent) &&
        event.assistantMessageEvent.type === "text_delta" &&
        typeof event.assistantMessageEvent.delta === "string"
      ) {
        pendingAssistantText += event.assistantMessageEvent.delta;
        // Do not enqueue one Promise per token. Long uninterrupted streaming
        // still reaches the durable cap through bounded 16 KiB flushes.
        if (Buffer.byteLength(pendingAssistantText, "utf8") < ASSISTANT_COALESCE_MAX_BYTES) {
          return Promise.resolve();
        }
        return enqueue(flushAssistant);
      }
      return enqueue(async () => {
        await flushAssistant();
        await appendTraceDrafts(resolved, traceDraftsFromSessionEvent(event), task);
      });
    },
    appendTerminal(input) {
      return enqueue(async () => {
        await flushAssistant();
        const summary = input.summary ? boundedTraceText(input.summary) : undefined;
        await appendTraceDrafts(
          resolved,
          [{ kind: "terminal", status: input.terminal, ...(summary ? { summary } : {}) }],
          task,
        );
      });
    },
    flush: () =>
      enqueue(async () => {
        await flushAssistant();
      }),
  };
}

/**
 * Finish fixture/mechanical-like agent paths that do not own a live Pi sink.
 * Existing trace rows are retained; only missing input, compact fixture items,
 * and terminal evidence are appended.
 */
export async function finalizeAttemptTranscript(
  sessionPath: string,
  input: {
    task?: string;
    items?: readonly AttemptItem[];
    summary?: string;
    terminal?: "done" | "error" | "cancelled";
    meta?: Record<string, unknown>;
  },
): Promise<string> {
  const resolved = path.resolve(sessionPath);
  // A live Pi sink has already persisted the full trail. Its compact
  // AttemptItem tail is deliberately not appended again at terminal time.
  const hasDurableTrace = (await readTraceFileState(resolved)).nextOrdinal > 1;
  const drafts: TraceDraft[] = [];
  if (!hasDurableTrace) {
    for (const item of input.items ?? []) {
      if (item.type === "text") {
        drafts.push({ kind: "assistant", content: boundedTraceText(item.text) });
      } else {
        drafts.push({
          kind: "tool_call",
          name: stringField(item.name, "tool"),
          ...(item.argsSummary ? { args: boundedTraceText(item.argsSummary) } : {}),
        });
      }
    }
  }
  const summary = input.summary ? boundedTraceText(input.summary) : undefined;
  drafts.push({
    kind: "terminal",
    status: input.terminal ?? "done",
    ...(summary ? { summary } : {}),
  });
  await appendTraceDrafts(resolved, drafts, input.task);
  return resolved;
}
