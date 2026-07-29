/**
 * Mechanical node execution router (validate / review.reduce / prepare / publish).
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import type { MechanicalHost } from "./host.js";
import { mechanicalPreparePublication } from "./prepare-publication.js";
import { mechanicalPublish } from "./publish.js";
import { mechanicalReviewReduce } from "./review-reduce.js";
import { mechanicalValidate } from "./validate.js";

export type { MechanicalHost } from "./host.js";

export async function executeMechanical(
  host: MechanicalHost,
  claim: ClaimedNode,
  signal: AbortSignal,
): Promise<PiAttemptOutcome> {
  const runDir = runWorkDir(host.workspace.rootPath, claim.runId);
  const attemptDir = path.join(runDir, "attempts", claim.attemptId);
  const workDir = path.join(attemptDir, "work");
  await mkdir(workDir, { recursive: true });
  if (signal.aborted) {
    await writeConversationTranscript({
      sessionPath: path.join(attemptDir, "session.jsonl"),
      nodeKey: claim.nodeKey,
      summary: "Error: attempt cancelled",
      meta: { mode: "failed", failureClass: "cancelled", kind: claim.kind },
    });
    return { type: "failed", error: "attempt cancelled", failureClass: "cancelled" };
  }

  if (claim.kind === "validate.pre" || claim.kind === "validate.final") {
    return mechanicalValidate(host, claim, workDir, runDir);
  }
  if (claim.kind === "review.reduce") {
    return mechanicalReviewReduce(host, claim, workDir, runDir);
  }
  if (claim.kind === "prepare.publication") {
    return mechanicalPreparePublication(host, claim, workDir, runDir);
  }
  if (claim.kind === "publish") {
    return mechanicalPublish(host, claim, workDir, runDir);
  }
  // Unknown mechanical kind: still leave a transcript for the dialog.
  const sessionPath = path.join(runDir, "attempts", claim.attemptId, "session.jsonl");
  await writeConversationTranscript({
    sessionPath,
    nodeKey: claim.nodeKey,
    summary: `Error: unsupported mechanical kind: ${claim.kind}`,
    meta: { mode: "failed", kind: claim.kind },
  });
  return {
    type: "failed",
    error: `unsupported mechanical kind: ${claim.kind}`,
    failureClass: "infrastructure",
  };
}
