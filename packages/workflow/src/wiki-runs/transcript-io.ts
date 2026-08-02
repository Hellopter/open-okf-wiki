/**
 * Attempt session.jsonl write/parse for Node details (secret-free).
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AttemptTraceEvent, AttemptTraceEventSchema } from "@okf-wiki/contract";
import { TRANSCRIPT_MAX_BYTES } from "./types.js";

/**
 * Write canonical trace JSONL for Node details UI.
 */
export async function writeConversationTranscript(input: {
  sessionPath: string;
  nodeKey: string;
  summary: string;
  meta?: Record<string, unknown>;
  /** When true, append to existing live JSONL instead of replacing. */
  preserveExisting?: boolean;
}): Promise<string> {
  const summary = input.summary.replace(/\s+/g, " ").trim().slice(0, 4_000) || input.nodeKey;
  await mkdir(path.dirname(input.sessionPath), { recursive: true });

  let existing: AttemptTraceEvent[] = [];
  if (input.preserveExisting) {
    try {
      const raw = (await readFile(input.sessionPath, "utf8")).trim();
      if (raw) {
        existing = raw
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => AttemptTraceEventSchema.parse(JSON.parse(line) as unknown));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const nextOrdinal = Math.max(0, ...existing.map((event) => event.ordinal)) + 1;
  const at = new Date().toISOString();
  const rows: AttemptTraceEvent[] = [
    ...existing,
    { trace: 1, ordinal: nextOrdinal, at, kind: "assistant", content: summary },
    {
      trace: 1,
      ordinal: nextOrdinal + 1,
      at,
      kind: "terminal",
      status: input.meta?.mode === "failed" ? "error" : "done",
      summary,
    },
  ];
  await writeFile(
    input.sessionPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return input.sessionPath;
}

/**
 * Append one safe terminal record without rewriting an active Attempt trace.
 *
 * A full trace may be at its retention limit already; in that case preserving
 * readable history matters more than forcing one final row past the reader's
 * hard cap. Retired non-trace files are left untouched and rejected by the
 * reader rather than being reinterpreted as current protocol data.
 */
export async function appendAttemptFailureTranscript(input: {
  sessionPath: string;
  summary: string;
}): Promise<string> {
  await mkdir(path.dirname(input.sessionPath), { recursive: true });
  const raw = await readFile(input.sessionPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes >= TRANSCRIPT_MAX_BYTES) return input.sessionPath;

  let nextOrdinal = 1;
  let validTrace = true;
  let lastTerminal:
    | { status: "done" | "error" | "cancelled"; summary?: string }
    | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = AttemptTraceEventSchema.parse(JSON.parse(line) as unknown);
      nextOrdinal = Math.max(nextOrdinal, row.ordinal + 1);
      if (row.kind === "terminal") {
        lastTerminal = { status: row.status, summary: row.summary };
      }
    } catch {
      validTrace = false;
      break;
    }
  }

  if (raw.trim() && !validTrace) return input.sessionPath;

  // Idempotent: a prior error terminal with a real summary is already readable.
  if (
    lastTerminal?.status === "error" &&
    typeof lastTerminal.summary === "string" &&
    lastTerminal.summary.trim().length > 0
  ) {
    return input.sessionPath;
  }

  const summary = input.summary.replace(/\s+/g, " ").trim().slice(0, 4_000) || "Attempt failed.";
  const record: AttemptTraceEvent = {
    trace: 1,
    ordinal: nextOrdinal,
    at: new Date().toISOString(),
    kind: "terminal",
    status: "error",
    summary,
  };
  const line = `${JSON.stringify(record)}\n`;
  if (bytes + Buffer.byteLength(line, "utf8") > TRANSCRIPT_MAX_BYTES) return input.sessionPath;
  await appendFile(input.sessionPath, line, "utf8");
  return input.sessionPath;
}

/**
 * Parse canonical Attempt trace JSONL. Every non-empty line is one complete
 * JSON value; a corrupt tail is an audit-integrity failure, not a partial page.
 */
export function parseTranscriptMessages(raw: string): unknown[] {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");

  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`transcript JSONL line ${index + 1} is invalid`);
    }
  });
}
