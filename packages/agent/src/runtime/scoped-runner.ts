/**
 * Live AgentRunner adapter: real in-process Pi sessions.
 *
 * Casts opaque port model handles to concrete Pi types at the boundary.
 */

import { mkdir } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentRunRequest,
  AgentRunner,
  WikiWriteRequest,
} from "../ports/agent-runner.js";
import type { SourceIgnoreInput as PiSourceIgnoreInput } from "./fs-operations.js";
import type { RunWorkdirLayout } from "./workdir.js";
import {
  type RunScopedAgentInput,
  runScopedAgent,
  runScopedAgentsParallel,
} from "./run-scoped-agent.js";

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
    wikiDir: input.wikiDir,
    customTools: input.customTools as ToolDefinition<any, any>[] | undefined,
    onProgress: input.onProgress,
  };
}

/** Live adapter: real in-process Pi sessions. */
export function createLiveProduceRuntime(): AgentRunner {
  return {
    kind: "live",
    async runAgent(input) {
      const result = await runScopedAgent(toScopedInput(input));
      return { ...result, mode: "live" };
    },
    async runAgentsParallel(tasks, opts) {
      const results = await runScopedAgentsParallel(tasks.map(toScopedInput), opts);
      return results.map((r) => ({ ...r, mode: "live" as const }));
    },
    async writeWiki(input) {
      const layout = asLayout(input.layout);
      await mkdir(layout.wikiDir, { recursive: true });
      await mkdir(layout.analysisDir, { recursive: true });
      const result = await runScopedAgent({
        role: "root_write",
        spanId: "root_write",
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
        wikiDir: layout.wikiDir,
        onProgress: input.onProgress,
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
