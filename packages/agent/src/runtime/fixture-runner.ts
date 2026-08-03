/**
 * Fixture AgentRunner: no LLM. Scriptable for repair / critical-fail tests.
 * Reviewer seats write analysis/defect-report.json (path-first) — no free-text handoff.
 */

import { mkdir } from "node:fs/promises";
import type { DefectReport } from "@okf-wiki/contract/wiki-runs";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  WikiWriteRequest,
  WikiWriteResult,
} from "../ports/agent-runner.js";
import { commitDefectReport } from "../review/commit-defect-report.js";
import { writeFixtureWiki } from "./wiki-pages.js";
import { finalizeAttemptTranscript } from "./attempt-transcript-sink.js";
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

const DEFAULT_CLEAN_REPORT: DefectReport = {
  version: 1,
  reviewerId: "fixture",
  clean: true,
  defects: [],
  summary: "NO_DEFECTS",
};

function abortError(): Error {
  const err = new Error("Wiki Run cancelled");
  err.name = "AbortError";
  return err;
}

function asLayout(layout: WikiWriteRequest["layout"]): RunWorkdirLayout {
  return layout as RunWorkdirLayout;
}

/** Path-first fixture reviewer: commit DefectReport under run workdir. */
async function commitFixtureReview(
  input: AgentRunRequest,
  report: DefectReport,
): Promise<AgentRunResult> {
  if (input.runWorkDir) {
    await commitDefectReport(input.runWorkDir, report, { reviewerId: report.reviewerId });
  }
  const summary = report.summary?.trim() || (report.clean ? "NO_DEFECTS" : `${report.defects.length} defect(s)`);
  const attemptId = input.spanId?.trim() || input.role;
  const items = [{ type: "text" as const, text: summary.slice(0, 2000) }];
  input.onProgress?.({
    attemptId,
    nodeKey: input.nodeKey?.trim() || attemptId,
    runIndex: input.runIndex ?? 0,
    role: "reviewer",
    status: "done",
    summary: summary.slice(0, 4000),
    items,
  });
  if (input.transcriptPath) {
    await finalizeAttemptTranscript(input.transcriptPath, {
      task: input.task,
      items,
      summary: summary.slice(0, 4000),
      terminal: "done",
      meta: { mode: "fixture", role: input.role, node: input.nodeKey ?? input.role },
    }).catch(() => undefined);
  }
  return {
    role: "reviewer",
    mode: "fixture",
    summary: summary.slice(0, 4000),
    items,
  };
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

    if (input.role === "reviewer") {
      return commitFixtureReview(input, DEFAULT_CLEAN_REPORT);
    }

    const summary = `[fixture ${input.role}] ${input.task.slice(0, 200)}`;

    const attemptId = input.spanId?.trim() || input.role;
    const items = [{ type: "text" as const, text: summary.slice(0, 2000) }];
    input.onProgress?.({
      attemptId,
      nodeKey: input.nodeKey?.trim() || attemptId,
      runIndex: input.runIndex ?? 0,
      role: input.role,
      status: "done",
      summary: summary.slice(0, 4000),
      items,
    });
    if (input.transcriptPath) {
      await finalizeAttemptTranscript(input.transcriptPath, {
        task: input.task,
        items,
        summary: summary.slice(0, 4000),
        terminal: "done",
        meta: { mode: "fixture", role: input.role, node: input.nodeKey ?? input.role },
      }).catch(() => undefined);
    }
    return {
      role: input.role,
      mode: "fixture",
      summary: summary.slice(0, 4000),
      items,
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
      // Fail-closed: empty wiki is a write failure for every writer path.
      if (pages.length === 0) {
        throw new Error("Pi fixture produce finished without writing any wiki markdown pages");
      }
      const summary =
        graphRole === "repair"
          ? "Pi fixture mode repaired overview.md + listing index.md"
          : "Pi fixture mode wrote overview.md + listing index.md";
      const items = [{ type: "text" as const, text: `wrote ${pages.join(", ")}` }];
      input.onProgress?.({
        attemptId,
        nodeKey,
        runIndex,
        role: graphRole,
        status: "done",
        summary,
        items,
      });
      if (input.transcriptPath) {
        await finalizeAttemptTranscript(input.transcriptPath, {
          task: input.task,
          items,
          summary,
          terminal: "done",
          meta: { mode: "fixture", role: graphRole, node: nodeKey },
        }).catch(() => undefined);
      }
      return {
        mode: "fixture",
        layout: input.layout,
        pages,
        summary,
        items,
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
      const report: DefectReport = blocking
        ? {
            version: 1,
            reviewerId: "fixture",
            clean: false,
            defects: [
              {
                severity: "blocking",
                code: "scripted_defect",
                path: "overview.md",
                issue: `Scripted blocking defect call ${reviewerCalls}`,
                reviewerId: "fixture",
              },
            ],
            summary: `blocking call ${reviewerCalls}`,
          }
        : DEFAULT_CLEAN_REPORT;
      return commitFixtureReview(req, report);
    },
  });
}
