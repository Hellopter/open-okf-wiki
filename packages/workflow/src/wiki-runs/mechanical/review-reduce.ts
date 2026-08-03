/**
 * Mechanical review.reduce execution (merge validated seat DefectReports → defects).
 *
 * Fail-closed (Phase 3 hard-cut):
 * - Each seat artifact must parse as DefectReportSchema (or per-seat Merged shape).
 * - Missing / malformed seats → attempt **failed** (never clean NO_DEFECTS).
 * - Zero seats when reviewRequired → failed.
 * - Zero seats when !reviewRequired → clean NO_DEFECTS.
 * - No keyword / empty-text / JSONL-guess soft paths.
 */

import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import { type DefectItem, type DefectReport, DefectReportSchema, type DefectSeverity, type MergedDefectReport, MergedDefectReportSchema, type WikiRunSpecAcceptance } from "@okf-wiki/contract/wiki-runs";
import { loadAcceptance } from "../repair-schedule.js";
import { asRows, requiredText } from "../sql.js";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { mechanicalFailed } from "./failed.js";
import type { WikiRunsControl } from "../ctx.js";
import { sealedInputPath } from "./host.js";

export type SeatFinding = {
  role: string;
  reviewerId: string;
  clean: boolean;
  defects: DefectItem[];
  summary: string;
  report: DefectReport;
};

function reviewerIdFromRole(role: string): string {
  // Namespaced bind: review.seat.grounding:review_seat → grounding
  const bare = role.includes(":") ? role.slice(0, role.indexOf(":")) : role;
  return bare.replace(/^review\.seat\./, "") || bare || "reviewer";
}

/**
 * Strict parse of one seat artifact body as DefectReportSchema.
 * No keyword heuristics, no empty→clean, no unstructured soft success.
 */
export function parseSeatDefectReport(
  role: string,
  text: string,
): { ok: true; finding: SeatFinding } | { ok: false; error: string } {
  const reviewerId = reviewerIdFromRole(role);
  const raw = text.trim();
  if (!raw) {
    return {
      ok: false,
      error: `review seat ${role}: empty artifact (DefectReport required; never treated as clean)`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Single fence unwrap only — still must be full DefectReport JSON.
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    if (fence?.[1]) {
      try {
        parsed = JSON.parse(fence[1]!.trim());
      } catch {
        return {
          ok: false,
          error: `review seat ${role}: artifact is not valid JSON DefectReport`,
        };
      }
    } else {
      return {
        ok: false,
        error: `review seat ${role}: artifact is not valid JSON DefectReport`,
      };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `review seat ${role}: artifact JSON must be a DefectReport object`,
    };
  }

  const obj = parsed as Record<string, unknown>;
  // Accept a seat-shaped report; stamp reviewerId from role when missing.
  const stamped = {
    version: 1 as const,
    reviewerId:
      typeof obj.reviewerId === "string" && obj.reviewerId.trim()
        ? obj.reviewerId.trim()
        : reviewerId,
    clean: obj.clean,
    defects: Array.isArray(obj.defects)
      ? obj.defects.map((d) => {
          if (!d || typeof d !== "object" || Array.isArray(d)) return d;
          const item = d as Record<string, unknown>;
          return {
            ...item,
            reviewerId:
              typeof item.reviewerId === "string" && item.reviewerId.trim()
                ? item.reviewerId.trim()
                : typeof obj.reviewerId === "string" && obj.reviewerId.trim()
                  ? obj.reviewerId.trim()
                  : reviewerId,
          };
        })
      : obj.defects,
    summary: obj.summary,
  };

  const report = DefectReportSchema.safeParse(stamped);
  if (!report.success) {
    const issue = report.error.issues[0];
    const where = issue
      ? `${issue.path.join(".") || "report"}: ${issue.message}`
      : "invalid DefectReport";
    return {
      ok: false,
      error: `review seat ${role}: ${where}`,
    };
  }

  return {
    ok: true,
    finding: {
      role,
      reviewerId: report.data.reviewerId,
      clean: report.data.clean,
      defects: report.data.defects,
      summary:
        report.data.summary?.trim() ||
        (report.data.clean ? "NO_DEFECTS" : `${report.data.defects.length} defect(s)`),
      report: report.data,
    },
  };
}

/** @deprecated name retained for tests — strict DefectReport parse only. */
export function parseSeatFinding(role: string, text: string): SeatFinding {
  const result = parseSeatDefectReport(role, text);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.finding;
}

export function mergeSeatFindings(
  findings: SeatFinding[],
  blockingSeverities: readonly DefectSeverity[] = ["blocking"],
): MergedDefectReport {
  const defects: DefectItem[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    for (const d of finding.defects) {
      const key = `${d.severity}:${d.code}:${d.path ?? ""}:${d.issue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      defects.push({
        ...d,
        reviewerId: d.reviewerId ?? finding.reviewerId,
      });
    }
  }
  const severitySet = new Set(
    blockingSeverities.length > 0 ? blockingSeverities : (["blocking"] as DefectSeverity[]),
  );
  const gateBlocking = defects.filter((d) => severitySet.has(d.severity));
  // Merged clean ⇔ no defects at all (schema invariant). Gate uses blockingSeverities separately.
  const clean = findings.length > 0 && findings.every((f) => f.clean) && defects.length === 0;
  return MergedDefectReportSchema.parse({
    clean,
    defects,
    summary: clean
      ? `Merged ${findings.length} review seats (clean)`
      : `Merged review: ${gateBlocking.length} gate-blocking (${[...severitySet].join("|")}), ${defects.length} total defect(s)`,
    reviewerIds: findings.map((f) => f.reviewerId),
  });
}

/** Whether merged defects should open the fix gate given Spec acceptance. */
export function hasGateBlockingDefects(
  report: MergedDefectReport,
  blockingSeverities: readonly DefectSeverity[] = ["blocking"],
): boolean {
  const severitySet = new Set(
    blockingSeverities.length > 0 ? blockingSeverities : (["blocking"] as DefectSeverity[]),
  );
  return report.defects.some((d) => severitySet.has(d.severity));
}

async function readSeatText(root: string): Promise<string> {
  const candidates: string[] = [
    path.join(root, "receipt.json"),
    path.join(root, "defect-report.json"),
    root,
  ];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.json$/i.test(entry.name) && !entry.name.endsWith(".jsonl")) {
        candidates.unshift(path.join(root, entry.name));
      }
    }
  } catch {
    // root may be a bare file
  }
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf8");
      // Reject JSONL transcripts — seats must seal a single DefectReport JSON object.
      if (candidate.endsWith(".jsonl")) continue;
      const trimmed = text.trim();
      if (!trimmed) continue;
      // Prefer files that look like DefectReport objects.
      if (trimmed.startsWith("{")) return trimmed;
    } catch {
      // next
    }
  }
  // Last resort: bare file path
  try {
    return (await readFile(root, "utf8")).trim();
  } catch {
    return "";
  }
}

function listConfiguredSeatKeys(host: WikiRunsControl, runId: string): string[] {
  return asRows(
    host.db
      .prepare(
        `SELECT DISTINCT node_key FROM nodes
         WHERE run_id = ? AND kind = 'review.seat'
         ORDER BY node_key`,
      )
      .all(runId),
  ).map((row) => requiredText(row, "node_key"));
}

export async function mechanicalReviewReduce(
  host: WikiRunsControl,
  claim: ClaimedNode,
  workDir: string,
  runDir: string,
): Promise<PiAttemptOutcome> {
  const wikiPath = sealedInputPath(host, claim, runDir, "wiki_tree");
  if (!wikiPath) {
    return mechanicalFailed({
      claim,
      runDir,
      error: "review.reduce requires sealed wiki_tree input",
      failureClass: "infrastructure",
    });
  }
  const stagingWiki = path.join(workDir, "wiki");
  await cp(wikiPath, stagingWiki, { recursive: true, dereference: false });
  await rm(path.join(stagingWiki, ".okf-artifact-manifest.json"), { force: true });

  const acceptance: WikiRunSpecAcceptance | undefined = loadAcceptance(host, claim.runId);
  const reviewRequired = acceptance?.reviewRequired !== false;
  const blockingSeverities: DefectSeverity[] =
    acceptance?.blockingSeverities && acceptance.blockingSeverities.length > 0
      ? acceptance.blockingSeverities
      : ["blocking"];

  // Only review_seat receipt roles — never transcripts (review.seat.X:transcript also
  // matches a naive LIKE 'review.seat.%' and is audit-only).
  const seatRows = asRows(
    host.db
      .prepare(
        `SELECT attempt_inputs.role, artifacts.relative_path
         FROM attempt_inputs
         JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
         WHERE attempt_inputs.attempt_id = ?
           AND (
             attempt_inputs.role = 'review_seat'
             OR attempt_inputs.role LIKE '%:review_seat'
           )`,
      )
      .all(claim.attemptId),
  );

  const configuredSeats = listConfiguredSeatKeys(host, claim.runId);

  if (seatRows.length === 0) {
    if (reviewRequired || configuredSeats.length > 0) {
      return mechanicalFailed({
        claim,
        runDir,
        error:
          configuredSeats.length > 0
            ? `review.reduce: ${configuredSeats.length} review.seat node(s) configured but no seat artifacts bound (fail-closed; never NO_DEFECTS)`
            : "review.reduce: reviewRequired=true but zero review seats are configured or bound (fail-closed; never NO_DEFECTS)",
        failureClass: "schema",
      });
    }
    // reviewRequired=false and no seats: clean path without council.
    const merged = MergedDefectReportSchema.parse({
      clean: true,
      defects: [],
      summary: "NO_DEFECTS (review not required; zero seats)",
      reviewerIds: [],
    });
    return sealReduceSuccess(host, claim, workDir, runDir, stagingWiki, merged, [], 0);
  }

  const findings: SeatFinding[] = [];
  const errors: string[] = [];
  for (const row of seatRows) {
    const role = requiredText(row, "role");
    const root = path.join(runDir, requiredText(row, "relative_path"));
    const text = await readSeatText(root);
    const parsed = parseSeatDefectReport(role, text);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    findings.push(parsed.finding);
  }

  if (errors.length > 0) {
    return mechanicalFailed({
      claim,
      runDir,
      error:
        `review.reduce: ${errors.length} invalid seat report(s): ${errors.slice(0, 4).join("; ")}`.slice(
          0,
          4_000,
        ),
      failureClass: "schema",
    });
  }

  // When seats are configured on the graph, require every configured seat to be present.
  if (configuredSeats.length > 0) {
    const present = new Set(
      findings.map((f) => {
        const bare = f.role.includes(":") ? f.role.slice(0, f.role.indexOf(":")) : f.role;
        return bare.startsWith("review.seat.") ? bare : `review.seat.${f.reviewerId}`;
      }),
    );
    // Also accept reviewerId-only matches against seat suffix.
    for (const f of findings) {
      present.add(`review.seat.${f.reviewerId}`);
    }
    const missing = configuredSeats.filter((key) => !present.has(key));
    if (missing.length > 0) {
      return mechanicalFailed({
        claim,
        runDir,
        error: `review.reduce: missing required seat artifact(s): ${missing.join(", ")} (fail-closed)`,
        failureClass: "schema",
      });
    }
  }

  const merged = mergeSeatFindings(findings, blockingSeverities);
  const round = Math.max(
    0,
    ...asRows(
      host.db
        .prepare(
          `SELECT COUNT(*) AS count FROM attempts
           WHERE run_id = ? AND node_key = 'review.reduce' AND state = 'succeeded'`,
        )
        .all(claim.runId),
    ).map((row) => Number(row.count ?? 0)),
  );

  return sealReduceSuccess(
    host,
    claim,
    workDir,
    runDir,
    stagingWiki,
    merged,
    findings,
    round,
    blockingSeverities,
  );
}

async function sealReduceSuccess(
  host: WikiRunsControl,
  claim: ClaimedNode,
  workDir: string,
  runDir: string,
  stagingWiki: string,
  merged: MergedDefectReport,
  findings: SeatFinding[],
  round: number,
  blockingSeverities: readonly DefectSeverity[] = ["blocking"],
): Promise<PiAttemptOutcome> {
  const defectsPath = path.join(workDir, "defects.json");
  await writeFile(defectsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  const candidateDigest =
    sealedInputPath(host, claim, runDir, "wiki_tree")?.split("/").pop() ?? claim.attemptId;
  const evaluationRound = {
    version: 1 as const,
    round,
    candidateDigest,
    seatReports: findings.map((f) => f.report),
    merged,
    result: hasGateBlockingDefects(merged, blockingSeverities) ? "blocking" : "clean",
    stopReason: hasGateBlockingDefects(merged, blockingSeverities)
      ? "gate_blocking_defects"
      : merged.clean
        ? "clean"
        : "non_blocking_defects_only",
    blockingSeverities: [...blockingSeverities],
  };
  const evalPath = path.join(workDir, "evaluation-round.json");
  await writeFile(evalPath, `${JSON.stringify(evaluationRound, null, 2)}\n`, "utf8");

  const summaryText = merged.summary ?? "review.reduce complete";
  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary: summaryText,
    meta: { defects: merged, evaluationRound: { round, result: evaluationRound.result } },
  });

  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "wiki_tree", role: "wiki_tree", sourcePath: stagingWiki, directory: true },
      { kind: "receipt", role: "defects", sourcePath: defectsPath, directory: false },
      { kind: "receipt", role: "evaluation_round", sourcePath: evalPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: summaryText,
    metrics: { role: "review" },
  };
}
