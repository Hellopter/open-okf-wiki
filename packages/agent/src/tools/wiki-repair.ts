/**
 * Operator-only wiki_repair tool (T2).
 * Repairs existing Run staging via workflow.repairWiki — never bash.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WikiRunSpec, WorkspaceConfig } from "@okf-wiki/contract";
import { loadRun, runWorkDir } from "@okf-wiki/core";
import { runWorkdirLayout } from "../runtime/run-workdir.js";
import type { AgentRunner } from "../ports/agent-runner.js";
import { readCommittedSpec } from "../produce/living-spec.js";
import {
  type ProduceRuntime,
  resolveProduceRuntime,
} from "../runtime/produce-runtime.js";
import { createToolDetailsAccumulator } from "../produce/progress.js";
import { listWikiMarkdown } from "../produce/wiki-pages.js";
import type { WikiProduceModelFactory } from "../workflow/run-wiki.js";
import { repairWiki } from "../workflow/produce.js";

export const WIKI_REPAIR_TOOL_NAME = "wiki_repair" as const;

export type CreateWikiRepairToolInput = {
  workspace: WorkspaceConfig;
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  resolveModel?: WikiProduceModelFactory;
  fixture?: boolean;
  /** Inject runtime for tests. */
  runtime?: ProduceRuntime | AgentRunner;
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
};

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
  let names: string[] = [];
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
      if (!runId) {
        const failed: WikiRepairToolDetails = {
          status: "failed",
          summary: "runId is required",
        };
        return {
          content: [{ type: "text" as const, text: failed.summary! }],
          details: failed,
        };
      }

      try {
        if (signal?.aborted) {
          const cancelled: WikiRepairToolDetails = {
            status: "cancelled",
            runId,
            summary: "Wiki repair cancelled",
          };
          return {
            content: [{ type: "text" as const, text: cancelled.summary! }],
            details: cancelled,
          };
        }

        const workspace = input.resolveWorkspace
          ? await input.resolveWorkspace()
          : input.workspace;
        const record = await loadRun(workspace.rootPath, runId);
        if (!record) {
          const failed: WikiRepairToolDetails = {
            status: "failed",
            runId,
            summary: `Wiki Run not found: ${runId}`,
          };
          return {
            content: [{ type: "text" as const, text: failed.summary! }],
            details: failed,
          };
        }

        const spec: WikiRunSpec | null = await readCommittedSpec(workspace.rootPath, runId);
        if (!spec) {
          const failed: WikiRepairToolDetails = {
            status: "failed",
            runId,
            summary: `No committed Spec for run ${runId}`,
          };
          return {
            content: [{ type: "text" as const, text: failed.summary! }],
            details: failed,
          };
        }

        const layout = await layoutForExistingRun(workspace.rootPath, runId);
        const runtime = resolveProduceRuntime({
          fixture: input.fixture,
          runtime: input.runtime,
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
            if (progress.kind === "attempt") {
              acc.apply({ kind: "attempt", attempt: progress.attempt });
              try {
                onUpdate?.(acc.toPartial() as never);
              } catch {
                // ignore
              }
            }
          },
        });

        if (produced.status === "cancelled") {
          const cancelled: WikiRepairToolDetails = {
            status: "cancelled",
            runId,
            summary: produced.summary || "Wiki repair cancelled",
          };
          return {
            content: [{ type: "text" as const, text: cancelled.summary! }],
            details: cancelled,
          };
        }

        const pages =
          produced.pages.length > 0
            ? produced.pages
            : await listWikiMarkdown(layout.wikiDir);

        const details: WikiRepairToolDetails = {
          status: "repaired",
          runId,
          pages,
          summary: produced.summary || `Repaired Staging Wiki (${pages.length} pages)`,
        };
        return {
          content: [{ type: "text" as const, text: details.summary! }],
          details,
        };
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || signal?.aborted)) {
          const cancelled: WikiRepairToolDetails = {
            status: "cancelled",
            runId,
            summary: "Wiki repair cancelled",
          };
          return {
            content: [{ type: "text" as const, text: cancelled.summary! }],
            details: cancelled,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        const failed: WikiRepairToolDetails = {
          status: "failed",
          runId,
          summary: message.slice(0, 4000),
        };
        return {
          content: [{ type: "text" as const, text: failed.summary! }],
          details: failed,
          isError: true,
        };
      }
    },
  });
}
