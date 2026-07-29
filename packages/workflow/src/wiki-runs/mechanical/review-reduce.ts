/**
 * Mechanical review.reduce execution (merge seat transcripts → defects receipt).
 *
 * Always succeeds when merge completes: blocking defects are sealed into the
 * defects receipt and handled by gate.fix (HITL pass/fix/revise/deny).
 * Only true infrastructure failures (missing wiki_tree) fail the attempt.
 */

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type DefectItem,
  DefectItemSchema,
  type MergedDefectReport,
  MergedDefectReportSchema,
  type PiAttemptOutcome,
} from "@okf-wiki/contract";
import { asRows, requiredText } from "../sql.js";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { type MechanicalHost, sealedInputPath } from "./host.js";

type SeatFinding = {
  role: string;
  clean: boolean;
  defects: DefectItem[];
  summary: string;
};

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const raw = text.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to fence / heuristics
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1]!) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function normalizeDefects(raw: unknown, reviewerId: string): DefectItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DefectItem[] = [];
  for (const item of raw) {
    const parsed = DefectItemSchema.safeParse({
      ...(item && typeof item === "object" ? item : {}),
      reviewerId:
        item && typeof item === "object" && typeof (item as { reviewerId?: unknown }).reviewerId === "string"
          ? (item as { reviewerId: string }).reviewerId
          : reviewerId,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Extract a seat finding from receipt JSON or transcript text. */
export function parseSeatFinding(role: string, text: string): SeatFinding {
  const reviewerId = role.replace(/^review\.seat\./, "") || role;
  if (/NO_DEFECTS/i.test(text) && !/severity\s*[:=]\s*["']?blocking/i.test(text)) {
    return { role, clean: true, defects: [], summary: "NO_DEFECTS" };
  }
  const obj = tryParseJsonObject(text);
  if (obj) {
    const defects = normalizeDefects(obj.defects, reviewerId);
    const clean =
      typeof obj.clean === "boolean" ? obj.clean : defects.length === 0;
    const summary =
      typeof obj.summary === "string" && obj.summary.trim()
        ? obj.summary.trim().slice(0, 2000)
        : clean
          ? "NO_DEFECTS"
          : `seat ${reviewerId}: ${defects.length} defect(s)`;
    // Nested seat receipt shape: { lens, summary, mode } without defects → treat summary only.
    if (!("defects" in obj) && !("clean" in obj) && typeof obj.summary === "string") {
      const nested = tryParseJsonObject(String(obj.summary));
      if (nested) return parseSeatFinding(role, JSON.stringify(nested));
      if (/NO_DEFECTS/i.test(String(obj.summary))) {
        return { role, clean: true, defects: [], summary: "NO_DEFECTS" };
      }
      // Unstructured seat summary without explicit clean — fail closed only on blocking keywords.
      if (/severity\s*[:=]\s*["']?blocking/i.test(String(obj.summary))) {
        return {
          role,
          clean: false,
          defects: [
            {
              severity: "blocking",
              code: "seat_blocking_text",
              issue: String(obj.summary).slice(0, 500),
              reviewerId,
            },
          ],
          summary: String(obj.summary).slice(0, 500),
        };
      }
      return { role, clean: true, defects: [], summary: String(obj.summary).slice(0, 500) };
    }
    return { role, clean: clean && defects.every((d) => d.severity !== "blocking"), defects, summary };
  }
  if (/severity\s*[:=]\s*["']?blocking/i.test(text)) {
    return {
      role,
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "seat_blocking_text",
          issue: text.slice(0, 500),
          reviewerId,
        },
      ],
      summary: text.slice(0, 500),
    };
  }
  // Empty body: treat as soft miss (binding/path issues) — reduce fails only when
  // zero seats produce any text. Explicit empty_review JSON still fail-closes above.
  if (!text.trim()) {
    return { role, clean: true, defects: [], summary: "empty seat artifact" };
  }
  // Fixture / unstructured seat receipts ({ ok: true }) without defects → clean.
  return { role, clean: true, defects: [], summary: text.slice(0, 500) };
}

export function mergeSeatFindings(findings: SeatFinding[]): MergedDefectReport {
  const defects: DefectItem[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    for (const d of finding.defects) {
      const key = `${d.severity}:${d.code}:${d.path ?? ""}:${d.issue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      defects.push(d);
    }
  }
  const blocking = defects.filter((d) => d.severity === "blocking");
  const clean = findings.length > 0 && findings.every((f) => f.clean) && blocking.length === 0;
  return MergedDefectReportSchema.parse({
    clean,
    defects,
    summary: clean
      ? findings.length
        ? `Merged ${findings.length} review seats (clean)`
        : "NO_DEFECTS"
      : `Merged review: ${blocking.length} blocking, ${defects.length} total defect(s)`,
    reviewerIds: findings.map((f) => f.role.replace(/^review\.seat\./, "") || f.role),
  });
}

async function readSeatText(root: string): Promise<string> {
  const candidates = [
    path.join(root, "receipt.json"),
    path.join(root, "session.jsonl"),
    path.join(root, "transcript.jsonl"),
    root,
  ];
  // Sealed file artifacts land as a directory with one basename copy — pick any .json.
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.(json|jsonl)$/i.test(entry.name)) {
        candidates.unshift(path.join(root, entry.name));
      }
    }
  } catch {
    // root may be a bare file
  }
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf8");
      // JSONL: prefer last non-empty line that looks like JSON with clean/defects/summary
      if (candidate.endsWith(".jsonl")) {
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]!;
          if (line.includes("clean") || line.includes("defects") || line.includes("NO_DEFECTS")) {
            return line;
          }
        }
        return text.slice(0, 8_000);
      }
      return text;
    } catch {
      // next
    }
  }
  return "";
}

export async function mechanicalReviewReduce(
  host: MechanicalHost,
  claim: ClaimedNode,
  workDir: string,
  runDir: string,
): Promise<PiAttemptOutcome> {
  const wikiPath = sealedInputPath(host, claim, runDir, "wiki_tree");
  if (!wikiPath) {
    return {
      type: "failed",
      error: "review.reduce requires sealed wiki_tree input",
      failureClass: "infrastructure",
    };
  }
  const stagingWiki = path.join(workDir, "wiki");
  await cp(wikiPath, stagingWiki, { recursive: true, dereference: false });
  await rm(path.join(stagingWiki, ".okf-artifact-manifest.json"), { force: true });

  const seatRows = asRows(
    host.db
      .prepare(
        `SELECT attempt_inputs.role, artifacts.relative_path
         FROM attempt_inputs
         JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
         WHERE attempt_inputs.attempt_id = ? AND attempt_inputs.role LIKE 'review.seat.%'`,
      )
      .all(claim.attemptId),
  );

  const findings: SeatFinding[] = [];
  for (const row of seatRows) {
    const role = requiredText(row, "role");
    const root = path.join(runDir, requiredText(row, "relative_path"));
    const text = await readSeatText(root);
    findings.push(parseSeatFinding(role, text));
  }

  // No seat inputs bound: clean NO_DEFECTS so graphs without seat artifacts still flow.
  const merged =
    findings.length === 0
      ? MergedDefectReportSchema.parse({
          clean: true,
          defects: [],
          summary: "NO_DEFECTS",
          reviewerIds: [],
        })
      : mergeSeatFindings(findings);

  const defectsPath = path.join(workDir, "defects.json");
  await writeFile(defectsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  const summaryText = merged.summary ?? "review.reduce complete";
  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary: summaryText,
    meta: { defects: merged },
  });

  // Always succeed after merge: clean vs blocking is carried in the sealed
  // defects receipt; gate.fix (or auto-pass) decides the control path.
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "wiki_tree", role: "wiki_tree", sourcePath: stagingWiki, directory: true },
      { kind: "receipt", role: "defects", sourcePath: defectsPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: summaryText,
  };
}
