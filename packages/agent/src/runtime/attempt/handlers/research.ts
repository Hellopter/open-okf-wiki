/**
 * research.leaf / research.domain: read-only evidence gathering Attempts.
 */

import { PiAttemptOutcomeSchema, type PiAttemptOutcome } from "@okf-wiki/contract";
import { domainResearchPrompt, leafResearchPrompt } from "../../../prompts/index.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  parseNodeDetail,
  sealTranscript,
  writeAnalysisJson,
} from "../shared.js";

const LEAF_SYSTEM =
  "You are a leaf researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.";

const DOMAIN_SYSTEM =
  "You are a domain researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.";

export async function handleResearchLeaf(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  const detail = parseNodeDetail(input);
  const domainId = String(detail.domainId ?? "core");
  const question = String(detail.question ?? input.node.key);
  const resolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
  const leafTask = leafResearchPrompt({
    domainId,
    question,
    scope: String(detail.scope ?? ""),
    nodeId: input.node.key,
    runId: input.runId,
  });
  const result = await runtime.runAgent({
    role: "leaf",
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    runWorkDir: input.workDir,
    task: leafTask,
    systemPrompt: LEAF_SYSTEM,
    preferFinalMessage: false,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    sourceIgnores: ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    transcriptPath: input.sessionPath,
  });
  if (result.failed) throw new Error(result.summary);
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, {
    role: "leaf",
    summary: result.summary,
    mode: result.mode,
  });
  const transcript = await sealTranscript(input, {
    task: leafTask,
    items: result.items,
    summary: result.summary,
    terminal: "done",
    meta: { mode: result.mode, role: "leaf" },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "research", sourcePath: receiptPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(result.summary),
  });
}

export async function handleResearchDomain(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  const detail = parseNodeDetail(input);
  const domainId = String(
    detail.domainId ?? input.node.key.replace(/^research\.domain\./, ""),
  );
  const resolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
  const domainTask = domainResearchPrompt({
    domainId,
    title: String(detail.title ?? domainId),
    scope: String(detail.scope ?? ""),
    questions: Array.isArray(detail.questions) ? detail.questions.map(String) : [],
    nodeId: input.node.key,
    runId: input.runId,
  });
  const result = await runtime.runAgent({
    role: "domain",
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    runWorkDir: input.workDir,
    task: domainTask,
    systemPrompt: DOMAIN_SYSTEM,
    preferFinalMessage: false,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    sourceIgnores: ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    transcriptPath: input.sessionPath,
  });
  if (result.failed) throw new Error(result.summary);
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, {
    role: "domain",
    summary: result.summary,
    mode: result.mode,
  });
  const transcript = await sealTranscript(input, {
    task: domainTask,
    items: result.items,
    summary: result.summary,
    terminal: "done",
    meta: { mode: result.mode, role: "domain" },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "research", sourcePath: receiptPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(result.summary),
  });
}
