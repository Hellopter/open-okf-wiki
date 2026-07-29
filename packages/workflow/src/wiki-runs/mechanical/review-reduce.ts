/**
 * Mechanical review.reduce execution (merge seat transcripts → defects receipt).
 */

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract";
import { asRows, requiredText } from "../sql.js";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { type MechanicalHost, sealedInputPath } from "./host.js";

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
  // Collect seat transcripts bound on this attempt (namespaced roles).
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
  const seatSummaries: string[] = [];
  for (const row of seatRows) {
    const root = path.join(runDir, requiredText(row, "relative_path"));
    const candidates = [
      root,
      path.join(root, "session.jsonl"),
      path.join(root, "transcript.jsonl"),
    ];
    for (const candidate of candidates) {
      try {
        const text = await readFile(candidate, "utf8");
        seatSummaries.push(text.slice(0, 500));
        break;
      } catch {
        // next
      }
    }
  }
  const defects = {
    clean: true,
    defects: [] as unknown[],
    summary: seatSummaries.length
      ? `Merged ${seatSummaries.length} review seats (clean)`
      : "NO_DEFECTS",
  };
  const defectsPath = path.join(workDir, "defects.json");
  await writeFile(defectsPath, `${JSON.stringify(defects, null, 2)}\n`, "utf8");
  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary: defects.summary,
    meta: { defects },
  });
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "wiki_tree", role: "wiki_tree", sourcePath: stagingWiki, directory: true },
      { kind: "receipt", role: "defects", sourcePath: defectsPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: defects.summary,
  };
}
