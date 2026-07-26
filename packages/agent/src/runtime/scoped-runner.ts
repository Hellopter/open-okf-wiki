/**
 * Live AgentRunner adapter: real in-process Pi sessions.
 *
 * Casts opaque port model handles to concrete Pi types at the boundary.
 */

import { mkdir } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRunner, AgentRunRequest, WikiWriteRequest } from "../ports/agent-runner.js";
import type { SourceIgnoreInput as PiSourceIgnoreInput } from "./fs-operations.js";
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

function toScopedInput(input: AgentRunRequest): RunScopedAgentInput {
  return {
    role: input.role,
    runWorkDir: input.runWorkDir,
    task: input.task,
    systemPrompt: input.systemPrompt,
    model: asModel(input.model),
    modelRuntime: asModelRuntime(input.modelRuntime),
    sourceIgnores: asSourceIgnores(input.sourceIgnores),
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    additionalSkillPaths: input.additionalSkillPaths,
    abortSignal: input.abortSignal,
    timeoutMs: input.timeoutMs,
    spanId: input.spanId,
    nodeKey: input.nodeKey,
    runIndex: input.runIndex,
    wikiDir: input.wikiDir,
    customTools: input.customTools as ToolDefinition<any, any>[] | undefined,
    onProgress: input.onProgress,
  };
}

export type LiveProduceRuntimeDefaults = {
  /** Wall-clock budget per child session (workspace limits.requestTimeoutSeconds). */
  timeoutMs?: number;
};

/** Live adapter: real in-process Pi sessions. */
export function createLiveProduceRuntime(defaults?: LiveProduceRuntimeDefaults): AgentRunner {
  const scoped = (input: AgentRunRequest): RunScopedAgentInput => ({
    ...toScopedInput(input),
    timeoutMs: input.timeoutMs ?? defaults?.timeoutMs,
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
        model: asModel(input.model),
        modelRuntime: asModelRuntime(input.modelRuntime),
        maxContextTokens: input.maxContextTokens,
        contextTargetTokens: input.contextTargetTokens,
        additionalSkillPaths: input.additionalSkillPaths,
        sourceIgnores: asSourceIgnores(input.sourceIgnores),
        abortSignal: input.abortSignal,
        timeoutMs: input.timeoutMs ?? defaults?.timeoutMs,
        wikiDir: layout.wikiDir,
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
      return {
        mode: "live",
        layout: input.layout,
        pages: result.pages ?? [],
        summary: result.summary,
      };
    },
  };
}
