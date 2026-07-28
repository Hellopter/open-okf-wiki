/**
 * Guarded operator repair entry: admission control + layout bootstrap + repairWiki.
 *
 * Tools call this rather than repairWiki directly so session ownership, run-status
 * gates, and in-process locks live outside the Pi adapter.
 * repairWiki remains the pure write path.
 */

import type { WorkspaceConfig } from "@okf-wiki/contract";
import { loadRun } from "@okf-wiki/core";
import type {
  AgentRunner,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
} from "../ports/agent-runner.js";
import { defaultSpecStore } from "../ports/core-spec-store.js";
import type { ProduceProgress } from "../ports/progress-sink.js";
import { listWikiMarkdown } from "../produce/wiki-pages.js";
import { layoutForExistingRun } from "./layout.js";
import {
  type ProduceWikiModels,
  repairWiki,
} from "./produce.js";

/** In-process guard: one repair per (workspace root, runId) at a time. */
const activeRepairs = new Set<string>();

/** Run Record statuses that still own the staging tree (do not repair mid-flight). */
const ACTIVE_RUN_STATUSES = new Set(["running", "awaiting_plan", "awaiting_publication"]);

export type RepairWikiGuardedInput = {
  runId: string;
  workspace: WorkspaceConfig;
  /** Operator Session that may repair this run (ADR 0032 ownership). */
  sessionId: string;
  runtime: AgentRunner;
  models?: ProduceWikiModels;
  /** Operator defect notes / repair focus. */
  defectNotes: string;
  abortSignal?: AbortSignal;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  onProgress?: (progress: ProduceProgress) => void;
  sourceIgnores?: SourceIgnoreInput;
};

export type RepairWikiGuardedResult =
  | {
      status: "repaired";
      runId: string;
      pages: string[];
      summary: string;
      layout: RunWorkdirLayoutPaths;
      mode: "fixture" | "live";
    }
  | {
      status: "cancelled";
      runId: string;
      pages: string[];
      summary: string;
    }
  | {
      status: "failed";
      runId?: string;
      summary: string;
      /**
       * true for policy/admission or unexpected failures the tool should mark isError.
       * false for soft failures (missing runId, not found, no committed Spec).
       */
      isError: boolean;
    };

/**
 * Admit + bootstrap + repair an existing Wiki Run staging tree.
 * Serializes concurrent repairs per (workspace root, runId).
 */
export async function repairWikiGuarded(
  input: RepairWikiGuardedInput,
): Promise<RepairWikiGuardedResult> {
  const runId = input.runId.trim();
  if (!runId) {
    return { status: "failed", summary: "runId is required", isError: false };
  }

  if (input.abortSignal?.aborted) {
    return {
      status: "cancelled",
      runId,
      pages: [],
      summary: "Wiki repair cancelled",
    };
  }

  let repairLockKey: string | null = null;
  try {
    const { workspace, sessionId } = input;
    const record = await loadRun(workspace.rootPath, runId);
    if (!record) {
      return {
        status: "failed",
        runId,
        summary: `Wiki Run not found: ${runId}`,
        isError: false,
      };
    }

    // A Wiki Run is linked to its Operator Session (ADR 0032): only that
    // session may repair its staging. Tool executionMode "sequential" only
    // serializes tools within one session, so this is the cross-session gate.
    if (record.sessionId !== sessionId) {
      return {
        status: "failed",
        runId,
        summary: `Wiki Run ${runId} belongs to Operator Session ${record.sessionId}; repair it from that session.`,
        isError: true,
      };
    }

    // Never write staging under an active run: a pending plan/publication
    // gate is about to read or publish exactly this tree.
    if (ACTIVE_RUN_STATUSES.has(record.status)) {
      return {
        status: "failed",
        runId,
        summary: `Wiki Run ${runId} is still active (${record.status}); wait for it to finish before repairing.`,
        isError: true,
      };
    }

    const lockKey = `${workspace.rootPath}\0${runId}`;
    if (activeRepairs.has(lockKey)) {
      return {
        status: "failed",
        runId,
        summary: `A repair for Wiki Run ${runId} is already in progress.`,
        isError: true,
      };
    }
    activeRepairs.add(lockKey);
    repairLockKey = lockKey;

    const spec = await defaultSpecStore.readCommittedSpec(workspace.rootPath, runId);
    if (!spec) {
      return {
        status: "failed",
        runId,
        summary: `No committed Spec for run ${runId}`,
        isError: false,
      };
    }

    const layout = await layoutForExistingRun(workspace.rootPath, runId);

    const produced = await repairWiki({
      runId,
      workspace,
      layout,
      spec,
      runtime: input.runtime,
      models: input.models,
      defectNotes: input.defectNotes,
      abortSignal: input.abortSignal,
      additionalSkillPaths: [layout.skillDir],
      maxContextTokens: input.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      onProgress: input.onProgress,
      sourceIgnores: input.sourceIgnores,
    });

    if (produced.status === "cancelled") {
      return {
        status: "cancelled",
        runId,
        pages: produced.pages,
        summary: produced.summary || "Wiki repair cancelled",
      };
    }

    const pages =
      produced.pages.length > 0 ? produced.pages : await listWikiMarkdown(layout.wikiDir);

    return {
      status: "repaired",
      runId,
      pages,
      summary: produced.summary || `Repaired Staging Wiki (${pages.length} pages)`,
      layout: produced.layout,
      mode: produced.mode,
    };
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || input.abortSignal?.aborted)) {
      return {
        status: "cancelled",
        runId,
        pages: [],
        summary: "Wiki repair cancelled",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      runId,
      summary: message.slice(0, 4000),
      isError: true,
    };
  } finally {
    if (repairLockKey) activeRepairs.delete(repairLockKey);
  }
}
