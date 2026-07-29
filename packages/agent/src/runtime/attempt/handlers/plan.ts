/**
 * plan node: produce an unsealed WikiRunSpec via planWikiSpec.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PiAttemptOutcomeSchema, type PiAttemptOutcome } from "@okf-wiki/contract";
import { createSubmitWikiRunSpecTool } from "../../../tools/submit-wiki-run-spec.js";
import { planWikiSpec } from "../../../workflow/phases/plan-phase.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  sealTranscript,
} from "../shared.js";

export async function handlePlan(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  if (input.node.key !== "plan") {
    throw new Error(`unsupported Pi attempt node: ${input.node.kind}/${input.node.key}`);
  }

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "planner", resolveModel) : undefined;
  const planTask = `Plan WikiRunSpec for ${input.workspace.name}`;
  const planned = await planWikiSpec({
    layout,
    workspaceName: input.workspace.name,
    wikiLanguage: input.workspace.wikiLanguage,
    runtime,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    orchestration: input.workspace.orchestration,
    sourceIgnores: ignores,
    abortSignal: signal,
    customTools: [createSubmitWikiRunSpecTool({ runWorkDir: input.workDir })],
    transcriptPath: input.sessionPath,
  });
  const specPath = path.join(layout.analysisDir, "spec.json");
  await writeFile(specPath, `${JSON.stringify(planned.spec, null, 2)}\n`, "utf8");
  const summary = bounded(planned.rawSummary ?? planned.spec.summary);
  const transcript = await sealTranscript(input, {
    task: planTask,
    items: planned.items,
    summary,
    terminal: "done",
    meta: { mode: planned.mode, source: planned.source },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "spec", role: "spec", sourcePath: specPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary,
  });
}
