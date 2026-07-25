/**
 * Live Pi / Fixture adapters for ports.AgentRunner.
 *
 * produceWiki depends on AgentRunner — this module only implements the port.
 * Casts opaque port model handles to concrete Pi types at the boundary.
 */

import { mkdir } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  WikiWriteRequest,
  WikiWriteResult,
} from "../ports/agent-runner.js";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput as PiSourceIgnoreInput } from "../pi/tool-operations.js";
import { shouldUsePiFixtureMode } from "./fixture-mode.js";
import {
  type RunScopedAgentInput,
  runScopedAgent,
  runScopedAgentsParallel,
} from "./run-scoped-agent.js";
import { writeFixtureWiki } from "./wiki-pages.js";

/** @deprecated Prefer AgentRunner from ports — alias for call-site migration. */
export type ProduceRuntime = AgentRunner;
export type ProduceAgentRequest = AgentRunRequest;
export type ProduceAgentResult = AgentRunResult;
export type ProduceWriteRequest = WikiWriteRequest;
export type ProduceWriteResult = WikiWriteResult;

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
      const results = await runScopedAgentsParallel(
        tasks.map(toScopedInput),
        opts,
      );
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

export type FixtureAgentHook = (
  input: ProduceAgentRequest,
) => Promise<ProduceAgentResult | undefined> | ProduceAgentResult | undefined;

export type FixtureWriteHook = (
  input: ProduceWriteRequest,
  writeOrdinal: number,
) => Promise<ProduceWriteResult | undefined> | ProduceWriteResult | undefined;

export type FixtureProduceRuntimeOptions = {
  onAgent?: FixtureAgentHook;
  onWrite?: FixtureWriteHook;
  /** When set, domain/leaf/etc. matching this predicate throw. */
  failAgent?: (input: ProduceAgentRequest) => Error | string | undefined;
};

const DEFAULT_CLEAN_REVIEW = JSON.stringify({
  clean: true,
  defects: [],
  summary: "NO_DEFECTS",
});

function abortError(): Error {
  const err = new Error("Wiki Run cancelled");
  err.name = "AbortError";
  return err;
}

/**
 * Fixture adapter: no LLM. Scriptable for repair / critical-fail tests.
 */
export function createFixtureProduceRuntime(
  options: FixtureProduceRuntimeOptions = {},
): ProduceRuntime {
  let writeOrdinal = 0;

  async function runOne(input: ProduceAgentRequest): Promise<ProduceAgentResult> {
    if (input.abortSignal?.aborted) throw abortError();

    const hooked = await options.onAgent?.(input);
    if (hooked) return hooked;

    const fail = options.failAgent?.(input);
    if (fail) {
      const err = typeof fail === "string" ? new Error(fail) : fail;
      const id = input.spanId?.trim() || input.role;
      input.onProgress?.({
        attemptId: id,
        nodeKey: id,
        runIndex: 0,
        role: input.role,
        status: "error",
        summary: err.message,
      });
      throw err;
    }

    const summary =
      input.role === "reviewer"
        ? DEFAULT_CLEAN_REVIEW
        : `[fixture ${input.role}] ${input.task.slice(0, 200)}`;

    const id = input.spanId?.trim() || input.role;
    input.onProgress?.({
      attemptId: id,
      nodeKey: id,
      runIndex: 0,
      role: input.role,
      status: "done",
      summary: summary.slice(0, 4000),
      items: [{ type: "text", text: summary.slice(0, 2000) }],
    });
    return {
      role: input.role,
      mode: "fixture",
      summary: summary.slice(0, 4000),
    };
  }

  return {
    kind: "fixture",
    runAgent: runOne,
    async runAgentsParallel(tasks, opts) {
      const concurrency = Math.max(1, opts?.concurrency ?? 2);
      const results: ProduceAgentResult[] = new Array(tasks.length);
      let next = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const i = next++;
          if (i >= tasks.length) return;
          results[i] = await runOne(tasks[i]!);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
      );
      return results;
    },
    async writeWiki(input) {
      writeOrdinal += 1;
      const hooked = await options.onWrite?.(input, writeOrdinal);
      if (hooked) return hooked;

      if (input.abortSignal?.aborted) throw abortError();
      const layout = asLayout(input.layout);
      await mkdir(layout.wikiDir, { recursive: true });
      await mkdir(layout.analysisDir, { recursive: true });
      const title =
        input.spec.summary?.trim() || input.workspaceName.trim() || "Repository overview";
      input.onProgress?.({
        attemptId: "root_write",
        nodeKey: "root_write",
        runIndex: 0,
        role: "root_write",
        status: "running",
        summary: "Fixture root_write",
      });
      const pages = await writeFixtureWiki(layout, title);
      const summary = "Pi fixture mode wrote overview.md + listing index.md";
      input.onProgress?.({
        attemptId: "root_write",
        nodeKey: "root_write",
        runIndex: 0,
        role: "root_write",
        status: "done",
        summary,
        items: [{ type: "text", text: `wrote ${pages.join(", ")}` }],
      });
      return {
        mode: "fixture",
        layout: input.layout,
        pages,
        summary,
      };
    },
  };
}

/**
 * Scripted fixture for repair / multi-round review tests.
 * First `blockingRounds` reviewer calls return blocking defects; later calls are clean.
 * With reviewCouncilSize=1 this equals council rounds.
 */
export function createScriptedReviewFixtureRuntime(input: {
  blockingRounds: number;
  failDomainId?: string;
  failDomainMessage?: string;
}): ProduceRuntime {
  let reviewerCalls = 0;
  return createFixtureProduceRuntime({
    failAgent: (req) => {
      if (!input.failDomainId || req.role !== "domain") return undefined;
      if (req.spanId === `domain-${input.failDomainId}`) {
        return input.failDomainMessage ?? `critical domain ${input.failDomainId} failed`;
      }
      return undefined;
    },
    onAgent: async (req) => {
      if (req.role !== "reviewer") return undefined;
      reviewerCalls += 1;
      const blocking = reviewerCalls <= input.blockingRounds;
      const text = blocking
        ? JSON.stringify({
            clean: false,
            defects: [
              {
                severity: "blocking",
                code: "scripted_defect",
                path: "overview.md",
                issue: `Scripted blocking defect call ${reviewerCalls}`,
              },
            ],
            summary: `blocking call ${reviewerCalls}`,
          })
        : DEFAULT_CLEAN_REVIEW;
      const id = req.spanId?.trim() || req.role;
      req.onProgress?.({
        attemptId: id,
        nodeKey: id,
        runIndex: 0,
        role: "reviewer",
        status: "done",
        summary: text.slice(0, 4000),
      });
      return {
        role: "reviewer",
        mode: "fixture",
        summary: text,
      };
    },
  });
}

export function resolveProduceRuntime(input: {
  fixture?: boolean;
  runtime?: ProduceRuntime;
}): ProduceRuntime {
  if (input.runtime) return input.runtime;
  if (shouldUsePiFixtureMode({ fixture: input.fixture })) {
    return createFixtureProduceRuntime();
  }
  return createLiveProduceRuntime();
}
