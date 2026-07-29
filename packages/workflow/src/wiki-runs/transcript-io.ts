/**
 * Attempt session.jsonl write/parse for Node details (secret-free).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Write conversation-shaped attempt session.jsonl for Node details UI.
 * Always includes at least one `{ role, content }` row so the dialog is not empty.
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

  let existing: unknown[] = [];
  if (input.preserveExisting) {
    try {
      const raw = (await readFile(input.sessionPath, "utf8")).trim();
      if (raw) {
        existing = raw
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as unknown);
      }
    } catch {
      // missing file — rebuild
    }
  }

  const rows: unknown[] =
    existing.length > 0
      ? [
          ...existing,
          { role: "assistant", content: summary },
          { schema: 1, node: input.nodeKey, summary, ...input.meta },
        ]
      : [
          { role: "assistant", content: summary },
          { schema: 1, node: input.nodeKey, summary, ...input.meta },
        ];
  await writeFile(
    input.sessionPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return input.sessionPath;
}

/**
 * Parse Attempt transcript file content.
 * Prefer JSONL (one JSON value per non-empty line). If the file is a single
 * JSON object/array (including pretty-printed multi-line), wrap/return as messages.
 * Tolerates mixed/corrupt tails from concurrent writers (live sink + finalize).
 */
export function parseTranscriptMessages(raw: string): unknown[] {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");

  // Fast path: pure JSONL (every non-empty line is one JSON value).
  if (lines.length > 0) {
    const rows: unknown[] = [];
    let jsonlOk = true;
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line) as unknown);
      } catch {
        jsonlOk = false;
        break;
      }
    }
    if (jsonlOk) return rows;
  }

  // Pretty-printed single JSON document (object or array).
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch {
    // Best-effort: keep any lines that still parse (partial concurrent write).
    const partial: unknown[] = [];
    for (const line of lines) {
      try {
        partial.push(JSON.parse(line) as unknown);
      } catch {
        // skip corrupt line
      }
    }
    if (partial.length > 0) return partial;
    throw new Error("transcript is not valid JSON/JSONL");
  }
}
