/**
 * Fixture AgentRunner: no LLM. Scriptable for repair / critical-fail tests.
 */

import { mkdir } from "node:fs/promises";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  WikiWriteRequest,
  WikiWriteResult,
} from "../ports/agent-runner.js";
import { writeFixtureWiki } from "../produce/wiki-pages.js";
import type { RunWorkdirLayout } from "./workdir.js";

export type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  WikiWriteRequest,
  WikiWriteResult,
} from "../ports/agent-runner.js";

export type FixtureAgentHook = (
  input: AgentRunRequest,
) => Promise<AgentRunResult | undefined> | AgentRunResult | undefined;

export type FixtureWriteHook = (
  input: WikiWriteRequest,
  writeOrdinal: number,
) => Promise<WikiWriteResult | undefined> | WikiWriteResult | undefined;

export type FixtureProduceRuntimeOptions = {
  onAgent?: FixtureAgentHook;
  onWrite?: FixtureWriteHook;
  /** When set, domain/leaf/etc. matching this predicate throw. */
  failAgent?: (input: AgentRunRequest) => Error | string | undefined;
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

function asLayout(layout: WikiWriteRequest["layout"]): RunWorkdirLayout {
  return layout as RunWorkdirLayout;
}

/**
 * Fixture adapter: no LLM. Scriptable for repair / critical-fail tests.
 */
export function createFixtureProduceRuntime(
  options: FixtureProduceRuntimeOptions = {},
): AgentRunner {
  let writeOrdinal = 0;

  async function runOne(input: AgentRunRequest): Promise<AgentRunResult> {
    if (input.abortSignal?.aborted) throw abortError();

    const hooked = await options.onAgent?.(input);
    if (hooked) return hooked;

    const fail = options.failAgent?.(input);
    if (fail) {
      const err = typeof fail === "string" ? new Error(fail) : fail;
      const attemptId = input.spanId?.trim() || input.role;
      input.onProgress?.({
        attemptId,
        nodeKey: input.nodeKey?.trim() || attemptId,
        runIndex: input.runIndex ?? 0,
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

    const attemptId = input.spanId?.trim() || input.role;
    input.onProgress?.({
      attemptId,
      nodeKey: input.nodeKey?.trim() || attemptId,
      runIndex: input.runIndex ?? 0,
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
      const results: AgentRunResult[] = new Array(tasks.length);
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
      const attemptId = input.spanId?.trim() || "root_write";
      const nodeKey = input.nodeKey?.trim() || attemptId;
      const runIndex = input.runIndex ?? 0;
      const graphRole = input.graphRole ?? "root_write";
      input.onProgress?.({
        attemptId,
        nodeKey,
        runIndex,
        role: graphRole,
        status: "running",
        summary: graphRole === "repair" ? "Fixture repair write" : "Fixture root_write",
      });
      const pages = await writeFixtureWiki(layout, title);
      const summary =
        graphRole === "repair"
          ? "Pi fixture mode repaired overview.md + listing index.md"
          : "Pi fixture mode wrote overview.md + listing index.md";
      input.onProgress?.({
        attemptId,
        nodeKey,
        runIndex,
        role: graphRole,
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
}): AgentRunner {
  let reviewerCalls = 0;
  return createFixtureProduceRuntime({
    failAgent: (req) => {
      if (!input.failDomainId || req.role !== "domain") return undefined;
      // Match retry attempts too (`domain-x@retry1`) — the scripted failure is
      // persistent, otherwise wired retries would defeat critical-fail tests.
      const nodeId = `domain-${input.failDomainId}`;
      if (req.spanId === nodeId || req.spanId?.startsWith(`${nodeId}@`)) {
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
      const attemptId = req.spanId?.trim() || req.role;
      req.onProgress?.({
        attemptId,
        nodeKey: req.nodeKey?.trim() || attemptId,
        runIndex: req.runIndex ?? 0,
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
