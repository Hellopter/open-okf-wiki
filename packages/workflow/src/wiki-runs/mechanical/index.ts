/**
 * Mechanical node execution router (validate / review.reduce / discover.reduce / prepare / publish).
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import { runWorkDir } from "@okf-wiki/core";
import type { ClaimedNode } from "../types.js";
import { mechanicalFailed } from "./failed.js";
import type { WikiRunsControl } from "../ctx.js";
import { mechanicalDiscoverReduce } from "./discover-reduce.js";
import { mechanicalPreparePublication } from "./prepare-publication.js";
import { mechanicalPublish } from "./publish.js";
import { mechanicalReviewReduce } from "./review-reduce.js";
import { mechanicalValidate } from "./validate.js";


export async function executeMechanical(
  host: WikiRunsControl,
  claim: ClaimedNode,
  signal: AbortSignal,
): Promise<PiAttemptOutcome> {
  const runDir = runWorkDir(host.workspace.rootPath, claim.runId);
  const attemptDir = path.join(runDir, "attempts", claim.attemptId);
  const workDir = path.join(attemptDir, "work");
  await mkdir(workDir, { recursive: true });
  if (signal.aborted) {
    return mechanicalFailed({
      claim,
      runDir,
      error: "attempt cancelled",
      failureClass: "cancelled",
    });
  }

  if (claim.kind === "validate.pre" || claim.kind === "validate.final") {
    return mechanicalValidate(host, claim, workDir, runDir);
  }
  if (claim.kind === "review.reduce") {
    return mechanicalReviewReduce(host, claim, workDir, runDir);
  }
  if (claim.kind === "plan.discover.reduce") {
    return mechanicalDiscoverReduce(host, claim, workDir, runDir);
  }
  if (claim.kind === "prepare.publication") {
    return mechanicalPreparePublication(host, claim, workDir, runDir);
  }
  if (claim.kind === "publish") {
    return mechanicalPublish(host, claim, workDir, runDir);
  }
  return mechanicalFailed({
    claim,
    runDir,
    error: `unsupported mechanical kind: ${claim.kind}`,
    failureClass: "infrastructure",
  });
}
