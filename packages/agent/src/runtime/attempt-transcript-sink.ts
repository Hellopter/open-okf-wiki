/**
 * Secret-free Attempt transcript writer for Node details UI.
 *
 * Attempt Pi sessions stay in-memory (disposable). This sink materialises a
 * JSONL projection at sessionPath so GET …/attempts/:id/transcript + poll can
 * show conversation/tool trail without Run SSE tokens (ADR 0035).
 *
 * Replace semantics: each write is a full snapshot so toolCall status updates
 * stay consistent (MAX_ITEMS is small).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttemptItem, NodeAttempt } from "@okf-wiki/contract";

const USER_CONTENT_MAX = 2_000;
const SUMMARY_MAX = 4_000;

/** One JSONL row projected by the web attempt-transcript helper. */
export type TranscriptRow =
  | { role: string; content: string }
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; status: string; argsSummary?: string };

export type AttemptTranscriptSink = {
  readonly path: string;
  /** Atomically replace the whole JSONL file with the given rows. */
  replace(rows: readonly TranscriptRow[]): Promise<void>;
  /**
   * Build conversation-shaped rows and replace.
   * Safe to call frequently from onProgress / subscribe.
   */
  writeProgress(input: {
    task?: string;
    items?: readonly AttemptItem[];
    summary?: string;
    /** When set, append an assistant/error closing line. */
    terminal?: "done" | "error" | "cancelled";
  }): Promise<void>;
};

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

/** Pure: AttemptItem[] (+ optional user task / summary) → secret-free rows. */
export function buildTranscriptRows(input: {
  task?: string;
  items?: readonly AttemptItem[];
  summary?: string;
  terminal?: "done" | "error" | "cancelled";
}): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const task = input.task ? truncate(input.task, USER_CONTENT_MAX) : "";
  if (task) {
    rows.push({ role: "user", content: task });
  }

  for (const item of input.items ?? []) {
    if (item.type === "text") {
      const text = truncate(item.text, USER_CONTENT_MAX);
      if (text) rows.push({ type: "text", text });
      continue;
    }
    if (item.type === "toolCall") {
      const row: TranscriptRow = {
        type: "toolCall",
        name: item.name || "tool",
        status: item.status || "done",
      };
      if (item.argsSummary?.trim()) {
        row.argsSummary = truncate(item.argsSummary, 500);
      }
      rows.push(row);
    }
  }

  const summary = input.summary ? truncate(input.summary, SUMMARY_MAX) : "";
  if (summary) {
    if (input.terminal === "error" || input.terminal === "cancelled") {
      rows.push({
        role: "assistant",
        content: input.terminal === "cancelled" ? `Cancelled: ${summary}` : `Error: ${summary}`,
      });
    } else if (input.terminal === "done" || !input.items?.length) {
      // Always surface a closing assistant line on terminal success, or when
      // there are no items yet (fixture / early progress with only summary).
      rows.push({ role: "assistant", content: summary });
    } else {
      // Mid-flight: summary is a progress note — keep as short assistant line
      // only when it is not already covered by the last text item.
      const last = rows[rows.length - 1];
      const lastText =
        last && "type" in last && last.type === "text"
          ? last.text
          : last && "role" in last
            ? last.content
            : "";
      if (lastText !== summary) {
        rows.push({ role: "assistant", content: summary });
      }
    }
  }

  return rows;
}

/** Map a NodeAttempt progress snapshot into transcript rows. */
export function rowsFromProgress(
  attempt: Pick<NodeAttempt, "items" | "summary" | "status">,
  task?: string,
): TranscriptRow[] {
  const terminal =
    attempt.status === "done"
      ? "done"
      : attempt.status === "error"
        ? "error"
        : attempt.status === "cancelled"
          ? "cancelled"
          : undefined;
  return buildTranscriptRows({
    task,
    items: attempt.items,
    summary: attempt.summary,
    terminal,
  });
}

function serializeRows(rows: readonly TranscriptRow[]): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/**
 * Create a sink bound to an attempt sessionPath (live session.jsonl).
 */
export function createAttemptTranscriptSink(sessionPath: string): AttemptTranscriptSink {
  const resolved = path.resolve(sessionPath);
  let chain: Promise<void> = Promise.resolve();

  const replace = (rows: readonly TranscriptRow[]): Promise<void> => {
    // Serialize writes so concurrent progress events do not interleave.
    const job = async () => {
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, serializeRows(rows), "utf8");
    };
    chain = chain.then(job, job);
    return chain;
  };

  return {
    path: resolved,
    replace,
    writeProgress(input) {
      return replace(buildTranscriptRows(input));
    },
  };
}

/**
 * Best-effort finalize: write terminal rows without throwing into the attempt outcome.
 * Returns the path when write succeeded.
 */
export async function finalizeAttemptTranscript(
  sessionPath: string,
  input: {
    task?: string;
    items?: readonly AttemptItem[];
    summary?: string;
    terminal?: "done" | "error" | "cancelled";
    /** Extra metadata row (schema/mode) — appended after conversation rows. */
    meta?: Record<string, unknown>;
    /**
     * When true and the file already has JSONL rows (live progress), append
     * terminal assistant + meta instead of wiping the conversation.
     * Used on failure/cancel after a partial run.
     */
    preserveExisting?: boolean;
  },
): Promise<string> {
  const resolved = path.resolve(sessionPath);
  await mkdir(path.dirname(resolved), { recursive: true });

  let existing: unknown[] = [];
  if (input.preserveExisting) {
    try {
      const raw = await readFile(resolved, "utf8");
      const trimmed = raw.trim();
      if (trimmed) {
        existing = trimmed
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as unknown);
      }
    } catch {
      // missing or unreadable — fall through to full rebuild
    }
  }

  if (existing.length > 0) {
    const extra: unknown[] = [];
    const summary = input.summary ? truncate(input.summary, SUMMARY_MAX) : "";
    if (summary) {
      const prefix =
        input.terminal === "cancelled"
          ? "Cancelled: "
          : input.terminal === "error"
            ? "Error: "
            : "";
      extra.push({ role: "assistant", content: `${prefix}${summary}` });
    }
    if (input.meta) extra.push({ schema: 1, ...input.meta });
    const lines = [...existing, ...extra].map((row) => JSON.stringify(row));
    await writeFile(resolved, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    return resolved;
  }

  const rows: TranscriptRow[] = buildTranscriptRows({
    task: input.task,
    items: input.items,
    summary: input.summary,
    terminal: input.terminal ?? "done",
  });
  // Meta is not a TranscriptRow; append as opaque object for operators/debug.
  // Web projector maps schema+summary stubs to assistant text.
  const payload: unknown[] = input.meta ? [...rows, { schema: 1, ...input.meta }] : rows;
  const lines = payload.map((row) => JSON.stringify(row));
  await writeFile(resolved, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  return resolved;
}
