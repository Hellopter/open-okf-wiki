/**
 * Uniform mechanical failed outcomes: write a readable error transcript, then
 * return a typed PiAttemptOutcome.failed so Activity matches attempts.error.
 */

import path from "node:path";
import type {
  PiAttemptArtifactDescriptor,
  PiAttemptFailureClass,
  PiAttemptOutcome,
} from "@okf-wiki/contract";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";

export async function mechanicalFailed(input: {
  claim: ClaimedNode;
  runDir: string;
  error: string;
  failureClass: PiAttemptFailureClass;
  /** Optional failure evidence (e.g. validate_report) sealed before terminal. */
  unsealedArtifacts?: PiAttemptArtifactDescriptor[];
  meta?: Record<string, unknown>;
}): Promise<PiAttemptOutcome> {
  const error = input.error.replace(/\s+/g, " ").trim().slice(0, 4_000) || "Attempt failed.";
  const sessionPath = path.join(
    input.runDir,
    "attempts",
    input.claim.attemptId,
    "session.jsonl",
  );
  const transcript = await writeConversationTranscript({
    sessionPath,
    nodeKey: input.claim.nodeKey,
    summary: error,
    meta: {
      mode: "failed",
      failureClass: input.failureClass,
      kind: input.claim.kind,
      ...input.meta,
    },
  });
  const unsealedArtifacts: PiAttemptArtifactDescriptor[] = [
    ...(input.unsealedArtifacts ?? []),
    { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
  ];
  return {
    type: "failed",
    error,
    failureClass: input.failureClass,
    unsealedArtifacts,
  };
}
