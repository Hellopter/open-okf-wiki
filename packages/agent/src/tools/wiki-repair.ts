/**
 * Operator-only wiki_repair tool (T2).
 * Repairs existing Run staging via workflow.repairWiki — never bash.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WikiProduceToolDetails, WikiRunSpec, WorkspaceConfig } from "@okf-wiki/contract";
import { loadRun, runWorkDir } from "@okf-wiki/core";
import type { AgentRunner } from "../ports/agent-runner.js";
import { defaultSpecStore } from "../ports/core-spec-store.js";
import { listWikiMarkdown } from "../produce/wiki-pages.js";
import { resolveProduceRuntime } from "../runtime/produce-runtime.js";
import { runWorkdirLayout } from "../runtime/workdir.js";
import { repairWiki } from "../workflow/produce.js";
import { applyGraphProgress, createRunGraphOwner } from "../workflow/run-graph-owner.js";
import type { WikiProduceModelFactory } from "../workflow/run-wiki.js";
import { createToolDetailsAccumulator } from "./wiki-produce-details.js";

export const WIKI_REPAIR_TOOL_NAME = "wiki_repair" as const;

/** In-process guard: one repair per (workspace root, runId) at a time. */
const activeRepairs = new Set<string>();

export type CreateWikiRepairToolInput = {
  workspace: WorkspaceConfig;
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  resolveModel?: WikiProduceModelFactory;
  fixture?: boolean;
  /** Inject runtime for tests. */
  runtime?: AgentRunner | AgentRunner;
};

const wikiRepairParameters = Type.Object(
  {
    runId: Type.String({
      description: "Existing Wiki Run id whose staging wiki should be repaired.",
      minLength: 1,
      maxLength: 200,
    }),
    notes: Type.Optional(
      Type.String({
        description: "Operator repair focus or defect notes.",
        maxLength: 4000,
      }),
    ),
  },
  { additionalProperties: false },
);

export type WikiRepairToolDetails = {
  status: "repairing" | "repaired" | "failed" | "cancelled";
  runId?: string;
  pages?: string[];
  summary?: string;
  /**
   * Live attempt graph forwarded from the repair workflow (same snapshot shape
   * as wiki_produce). Status stays the repair enum above — never "producing".
   */
  graph?: WikiProduceToolDetails["graph"];
};

/** Normalize repair tool early/final returns (content + details [+ isError]). */
export function toRepairToolResult(
  details: WikiRepairToolDetails,
  opts?: { isError?: boolean },
): {
  content: Array<{ type: "text"; text: string }>;
  details: WikiRepairToolDetails;
  isError?: boolean;
} {
  return {
    content: [{ type: "text" as const, text: details.summary ?? details.status }],
    details,
    ...(opts?.isError ? { isError: true as const } : {}),
  };
}

/**
 * Reconstruct RunWorkdirLayout from an existing frozen run on disk.
 */
export async function layoutForExistingRun(
  workspaceRoot: string,
  runId: string,
): Promise<ReturnType<typeof runWorkdirLayout>> {
  const work = runWorkDir(workspaceRoot, runId);
  const sourcesDir = path.join(work, "sources");
  const mounts = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(sourcesDir);
  } catch {
    throw new Error(`Run workdir sources missing for run ${runId}`);
  }
  for (const name of names) {
    const abs = path.join(sourcesDir, name);
    try {
      if ((await stat(abs)).isDirectory()) mounts.set(name, abs);
    } catch {
      // ignore unreadable entries
    }
  }
  if (mounts.size === 0) {
    throw new Error(`Run ${runId} has no source mounts under sources/`);
  }
  return runWorkdirLayout(work, mounts);
}

/** Pure factory test seam: build tool definition without session. */
export function createWikiRepairTool(
  input: CreateWikiRepairToolInput,
): ToolDefinition<typeof wikiRepairParameters, WikiRepairToolDetails> {
  return defineTool({
    name: WIKI_REPAIR_TOOL_NAME,
    label: "Repair wiki",
    description: [
      "Repair the Staging Wiki for an existing Wiki Run (root_write only).",
      "Use when the operator asks to fix, repair, or address defects on an existing run.",
      "Requires runId. Does NOT freeze a new run. Never use bash for wiki fixes.",
    ].join(" "),
    promptSnippet: "Repair existing Wiki Run staging (runId required)",
    promptGuidelines: [
      "When the operator asks to fix or repair the Wiki for an existing run, call wiki_repair with that runId.",
      "Never use bash to edit wiki pages — always wiki_repair (or wiki_produce for a full new run).",
      "Do not call wiki_repair to start a new Wiki Run; use wiki_produce for produce/refresh.",
    ],
    parameters: wikiRepairParameters,
    executionMode: "sequential",
    async execute(_toolCallId, args, signal, onUpdate) {
      const acc = createToolDetailsAccumulator({
        status: "producing",
        runId: args.runId,
        summary: "Repairing Staging Wiki",
      });
      /** Repair path has no runWiki shell; local owner projects attempts → graph. */
      const graphOwner = createRunGraphOwner();
      const push = (details: WikiRepairToolDetails): void => {
        try {
          onUpdate?.({
            content: [{ type: "text" as const, text: details.summary ?? details.status }],
            details,
          });
        } catch {
          // display must not break repair
        }
      };

      const runId = args.runId.trim();
      let repairLockKey: string | null = null;
      if (!runId) {
        return toRepairToolResult({
          status: "failed",
          summary: "runId is required",
        });
      }

      try {
        if (signal?.aborted) {
          return toRepairToolResult({
            status: "cancelled",
            runId,
            summary: "Wiki repair cancelled",
          });
        }

        const workspace = input.resolveWorkspace ? await input.resolveWorkspace() : input.workspace;
        const record = await loadRun(workspace.rootPath, runId);
        if (!record) {
          return toRepairToolResult({
            status: "failed",
            runId,
            summary: `Wiki Run not found: ${runId}`,
          });
        }

        // A Wiki Run is linked to its Operator Session (ADR 0032): only that
        // session may repair its staging. executionMode "sequential" only
        // serializes tools within one session, so this is the cross-session gate.
        if (record.sessionId !== input.sessionId) {
          return toRepairToolResult(
            {
              status: "failed",
              runId,
              summary: `Wiki Run ${runId} belongs to Operator Session ${record.sessionId}; repair it from that session.`,
            },
            { isError: true },
          );
        }

        // Never write staging under an active run: a pending plan/publication
        // gate is about to read or publish exactly this tree.
        if (
          record.status === "running" ||
          record.status === "awaiting_plan" ||
          record.status === "awaiting_publication"
        ) {
          return toRepairToolResult(
            {
              status: "failed",
              runId,
              summary: `Wiki Run ${runId} is still active (${record.status}); wait for it to finish before repairing.`,
            },
            { isError: true },
          );
        }

        const lockKey = `${workspace.rootPath}\0${runId}`;
        if (activeRepairs.has(lockKey)) {
          return toRepairToolResult(
            {
              status: "failed",
              runId,
              summary: `A repair for Wiki Run ${runId} is already in progress.`,
            },
            { isError: true },
          );
        }
        activeRepairs.add(lockKey);
        repairLockKey = lockKey;

        const spec: WikiRunSpec | null = await defaultSpecStore.readCommittedSpec(
          workspace.rootPath,
          runId,
        );
        if (!spec) {
          return toRepairToolResult({
            status: "failed",
            runId,
            summary: `No committed Spec for run ${runId}`,
          });
        }

        const layout = await layoutForExistingRun(workspace.rootPath, runId);
        const runtime = resolveProduceRuntime({
          fixture: input.fixture,
          runtime: input.runtime,
          defaults: {
            timeoutMs:
              typeof workspace.limits?.requestTimeoutSeconds === "number" &&
              workspace.limits.requestTimeoutSeconds > 0
                ? workspace.limits.requestTimeoutSeconds * 1000
                : undefined,
          },
        });

        let writerModel: { model?: unknown; modelRuntime?: unknown; maxContextTokens?: number } =
          {};
        if (!input.fixture && runtime.kind === "live" && input.resolveModel) {
          writerModel = await input.resolveModel("writer", workspace);
        }

        const notes = args.notes?.trim();
        const defectNotes = notes
          ? `Operator repair notes:\n${notes}`
          : "Operator requested repair of Staging Wiki; fix grounding, coverage, and consistency issues.";

        push({ status: "repairing", runId, summary: "root_write repair" });
        acc.apply({ kind: "status", status: "producing", summary: "root_write repair" });
        acc.apply({ kind: "runId", runId });

        const produced = await repairWiki({
          runId,
          workspace,
          layout,
          spec,
          runtime,
          models: writerModel.model
            ? {
                writer: {
                  model: writerModel.model,
                  modelRuntime: writerModel.modelRuntime,
                  maxContextTokens: writerModel.maxContextTokens,
                },
              }
            : undefined,
          defectNotes,
          abortSignal: signal,
          additionalSkillPaths: [layout.skillDir],
          contextTargetTokens: workspace.limits?.contextTargetTokens,
          onProgress: (progress) => {
            // Graph authority is local owner; live details keep repair status enum.
            applyGraphProgress(graphOwner, progress, (graph) => {
              acc.apply({ kind: "graph", graph });
              push({
                status: "repairing",
                runId,
                summary: "root_write repair",
                graph,
              });
            });
          },
        });

        if (produced.status === "cancelled") {
          return toRepairToolResult({
            status: "cancelled",
            runId,
            summary: produced.summary || "Wiki repair cancelled",
          });
        }

        const pages =
          produced.pages.length > 0 ? produced.pages : await listWikiMarkdown(layout.wikiDir);

        return toRepairToolResult({
          status: "repaired",
          runId,
          pages,
          summary: produced.summary || `Repaired Staging Wiki (${pages.length} pages)`,
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || signal?.aborted)) {
          return toRepairToolResult({
            status: "cancelled",
            runId,
            summary: "Wiki repair cancelled",
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return toRepairToolResult(
          {
            status: "failed",
            runId,
            summary: message.slice(0, 4000),
          },
          { isError: true },
        );
      } finally {
        if (repairLockKey) activeRepairs.delete(repairLockKey);
      }
    },
  });
}
