/**
 * Live AgentRunner adapter: real in-process Pi sessions.
 *
 * Casts opaque port model handles to concrete Pi types at the boundary.
 * Empty-pages fail-closed lives here (writeWiki), not in runScopedAgent.
 */

import { mkdir } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RetryLimits } from "@okf-wiki/contract";
import type { AgentRunner, AgentRunRequest, WikiWriteRequest } from "../ports/agent-runner.js";
import { listWikiMarkdown } from "../produce/wiki-pages.js";
import type { SourceIgnoreInput as PiSourceIgnoreInput } from "./path-policy.js";
import {
  type RunScopedAgentInput,
  runScopedAgent,
  runScopedAgentsParallel,
} from "./run-scoped-agent.js";
import type { RunWorkdirLayout } from "./workdir.js";

function asModel(model: unknown): Model<any> | undefined {
  return model as Model<any> | undefined;
}

function asModelRuntime(runtime: unknown): ModelRuntime | undefined {
  return runtime as ModelRuntime | undefined;
}

function asSourceIgnores(input: AgentRunRequest["sourceIgnores"]): PiSourceIgnoreInput | undefined {
  return input as PiSourceIgnoreInput | undefined;
}

function asLayout(layout: WikiWriteRequest["layout"]): RunWorkdirLayout {
  return layout as RunWorkdirLayout;
}

/** Port → live: spread AgentRunRequest, cast only opaque Pi boundary fields. */
function toScopedInput(input: AgentRunRequest): RunScopedAgentInput {
  return {
    ...input,
    model: asModel(input.model),
    modelRuntime: asModelRuntime(input.modelRuntime),
    sourceIgnores: asSourceIgnores(input.sourceIgnores),
    customTools: input.customTools as ToolDefinition<any, any>[] | undefined,
  };
}

export type LiveProduceRuntimeDefaults = {
  /** Wall-clock budget per child session (workspace limits.requestTimeoutSeconds). */
  timeoutMs?: number;
  /** Default Pi retry policy (workspace.limits.retry) when request omits retry. */
  retry?: RetryLimits;
};

/** Live adapter: real in-process Pi sessions. */
export function createLiveProduceRuntime(defaults?: LiveProduceRuntimeDefaults): AgentRunner {
  const scoped = (input: AgentRunRequest): RunScopedAgentInput => ({
    ...toScopedInput(input),
    timeoutMs: input.timeoutMs ?? defaults?.timeoutMs,
    retry: input.retry ?? defaults?.retry,
  });
  return {
    kind: "live",
    async runAgent(input) {
      const result = await runScopedAgent(scoped(input));
      return { ...result, mode: "live" };
    },
    async runAgentsParallel(tasks, opts) {
      const results = await runScopedAgentsParallel(tasks.map(scoped), opts);
      return results.map((r) => ({ ...r, mode: "live" as const }));
    },
    async writeWiki(input) {
      const layout = asLayout(input.layout);
      await mkdir(layout.wikiDir, { recursive: true });
      await mkdir(layout.analysisDir, { recursive: true });
      // Session tools stay root_write; graph identity may be repair@{n}.
      const attemptId = input.spanId?.trim() || "root_write";
      const nodeKey = input.nodeKey?.trim() || attemptId;
      const runIndex = input.runIndex ?? 0;
      const graphRole = input.graphRole ?? "root_write";
      const result = await runScopedAgent({
        role: "root_write",
        spanId: attemptId,
        nodeKey,
        runIndex,
        runWorkDir: layout.runWorkDir,
        task: input.task,
        systemPrompt: input.systemPrompt,
        preferFinalMessage: false,
        model: asModel(input.model),
        modelRuntime: asModelRuntime(input.modelRuntime),
        maxContextTokens: input.maxContextTokens,
        contextTargetTokens: input.contextTargetTokens,
        retry: input.retry ?? defaults?.retry,
        additionalSkillPaths: input.additionalSkillPaths,
        sourceIgnores: asSourceIgnores(input.sourceIgnores),
        abortSignal: input.abortSignal,
        timeoutMs: input.timeoutMs ?? defaults?.timeoutMs,
        transcriptPath: input.transcriptPath,
        onProgress: input.onProgress
          ? (span) =>
              input.onProgress!({
                ...span,
                attemptId,
                nodeKey,
                runIndex,
                role: graphRole,
              })
          : undefined,
      });
      // Fail-closed: empty wiki is a write failure for every live writer.
      const pages = await listWikiMarkdown(layout.wikiDir);
      if (pages.length === 0) {
        throw new Error("Pi live produce finished without writing any wiki markdown pages");
      }
      return {
        mode: "live",
        layout: input.layout,
        pages,
        summary: result.summary?.trim() || `Pi live produce wrote ${pages.length} page(s)`,
        ...(result.items ? { items: result.items } : {}),
      };
    },
  };
}
