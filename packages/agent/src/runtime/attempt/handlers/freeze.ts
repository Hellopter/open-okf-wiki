/**
 * Freeze probe: WikiRuns owns freeze; executor returns a no-op success so one
 * PiAttemptExecutor can be wired for all node kinds.
 */

import { PiAttemptOutcomeSchema, type PiAttemptOutcome } from "@okf-wiki/contract";
import { type AttemptHandlerContext, sealTranscript } from "../shared.js";

export async function handleFreeze(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input } = ctx;
  const transcript = await sealTranscript(input, {
    summary: "Freeze inputs already sealed by WikiRuns",
    terminal: "done",
    meta: { mode: "freeze_noop" },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      {
        kind: "manifest",
        role: "attempt_output",
        sourcePath: input.workDir,
        directory: true,
      },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: "Freeze inputs already sealed by WikiRuns",
  });
}
