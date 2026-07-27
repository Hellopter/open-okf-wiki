/**
 * Deep Wiki Run shell (ADR 0032 / 0033): freeze → plan → gates → produce → publish.
 *
 * wiki_produce tool is a thin Pi adapter over this module.
 * Inject freeze/publish/runtime for tests — not compatibility shims.
 *
 * Workflow stays free of Pi SDK and tools/: model handles are opaque;
 * plan customTools are injected from the tool edge.
 *
 * Canonical job phase is WikiRunPhase; Run Record status and tool details
 * status are projections via recordStatusFromPhase / toolStatusFromPhase.
 */

import path from "node:path";
import {
  recordStatusFromPhase,
  toolStatusFromPhase,
  type WikiProduceToolDetails,
  type WikiRunPhase,
  type WikiRunSpec,
  WikiRunSpecSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  type FrozenRunBoundary,
  freezeWikiRun,
  publishStagingToPublication,
  updateRunRecord,
} from "@okf-wiki/core";
import { createCoreGraphStore } from "../ports/core-graph-store.js";
import type { GatePort } from "../ports/gate-port.js";
import type { GraphStore } from "../ports/graph-store.js";
import {
  type ProduceProgress,
  type ProgressSink,
  progressSinkFromCallback,
} from "../ports/progress-sink.js";
import { commitSpec } from "../produce/living-spec.js";
import { redactErrorMessage } from "../redact/index.js";
import { shouldUsePiFixtureMode } from "../runtime/fixture-mode.js";
import { type AgentRunner, resolveProduceRuntime } from "../runtime/produce-runtime.js";
import { layoutFromFrozen } from "../runtime/workdir.js";
import { requestTimeoutMs, resolveOrchestration } from "./budgets.js";
import { runPlanGateLoop, runPublicationGateLoop } from "./gate-protocol.js";
import { AttemptJournal } from "./journal.js";
import { planWikiSpec } from "./phases/plan-phase.js";
import { produceWiki } from "./produce.js";
import { topologyFromSpec } from "./topology.js";

export type { GateDecision, GatePort, GateRequest } from "../ports/gate-port.js";

export type WikiProduceModelRole = "writer" | "planner" | "worker" | "reviewer";

export type WikiProduceModelFactory = (
  role: WikiProduceModelRole,
  workspace: WorkspaceConfig,
  /** Optional seat for multi-reviewer council (roleModels.reviewers[i]). */
  opts?: { seatIndex?: number },
) => Promise<{
  /** Opaque model handle — runtime adapters cast to Pi Model. */
  model: unknown;
  /** Opaque model runtime — runtime adapters cast to Pi ModelRuntime. */
  modelRuntime?: unknown;
  maxContextTokens?: number;
}>;

export type RunWikiInput = {
  workspace: WorkspaceConfig;
  /** Resolve once at execute so long-lived sessions see saved Workspace edits. */
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  toolCallId: string;
  notes?: string;
  autoApprove?: boolean;
  gateCoordinator: GatePort;
  resolveModel?: WikiProduceModelFactory;
  /** Explicit fixture path for tests. */
  fixture?: boolean;
  runtime?: AgentRunner;
  freeze?: (input: {
    workspace: WorkspaceConfig;
    sessionId: string;
    autoApprove?: boolean;
  }) => Promise<FrozenRunBoundary>;
  publish?: typeof publishStagingToPublication;
  abortSignal?: AbortSignal;
  onProgress?: (progress: ProduceProgress) => void;
  /**
   * Optional progress port. When omitted, wraps `onProgress` via
   * progressSinkFromCallback so orchestration always emits through ProgressSink.
   */
  progressSink?: ProgressSink;
  /**
   * Optional durable Run Graph store. When omitted, defaults to
   * createCoreGraphStore(workspaceRoot) at first topology publish.
   * Tests inject a memory store to assert save/load without disk.
   */
  graphStore?: GraphStore;
  /** Low-level status patches for gate/record (tool maps to details). */
  onDetails?: (patch: Partial<WikiProduceToolDetails>) => void;
  /**
   * Opaque plan-phase custom tools (submit_wiki_run_spec). Injected by the
   * tool edge so workflow never imports tools/ or Pi SDK.
   */
  createPlanTools?: (runWorkDir: string) => readonly unknown[];
};

export type RunWikiResult = WikiProduceToolDetails;

export type ResolvedProduceModels = {
  writer?: {
    model: unknown;
    modelRuntime?: unknown;
    maxContextTokens?: number;
  };
  planner?: {
    model: unknown;
    modelRuntime?: unknown;
    maxContextTokens?: number;
  };
  worker?: {
    model: unknown;
    modelRuntime?: unknown;
    maxContextTokens?: number;
  };
  reviewer?: {
    model: unknown;
    modelRuntime?: unknown;
    maxContextTokens?: number;
  };
};

function abortError(): Error {
  const error = new Error("Wiki Run cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Resolve role models for a live Wiki Run.
 *
 * - planner / worker: may fall back to writer when their factory throws
 *   (tolerated hybrid economics — cheaper roles share the writer profile).
 * - reviewer: **fail-closed** — factory throw leaves reviewer undefined so
 *   produceWiki can emit `reviewer_missing` rather than silently reviewing
 *   with the writer model (ADR 0032).
 * - empty roleModels + successful factory(workspace.model) is fine; that is
 *   not a resolution failure.
 */
export async function resolveModels(
  factory: WikiProduceModelFactory | undefined,
  fixture: boolean,
  workspace: WorkspaceConfig,
): Promise<ResolvedProduceModels> {
  if (fixture) return {};
  if (!factory) {
    throw new Error("Live wiki_produce requires a model resolver");
  }
  const writer = await factory("writer", workspace);
  const councilSize = Math.max(1, workspace.orchestration?.reviewCouncilSize ?? 3);
  const [planner, worker, ...reviewerSeats] = await Promise.all([
    // Tolerated: planner/worker may share the writer profile on factory failure.
    factory("planner", workspace).catch(() => writer),
    factory("worker", workspace).catch(() => writer),
    // Fail-closed per seat: do NOT fall back to writer.
    ...Array.from({ length: councilSize }, (_, seatIndex) =>
      factory("reviewer", workspace, { seatIndex }).then(
        (resolved) => resolved,
        () => undefined,
      ),
    ),
  ]);
  const reviewers = reviewerSeats.filter(
    (r): r is NonNullable<(typeof reviewerSeats)[number]> => r !== undefined,
  );
  // If seat 0 failed but a later seat succeeded, still expose a primary reviewer.
  const reviewer = reviewers[0];
  return {
    writer,
    planner,
    worker,
    ...(reviewer ? { reviewer, reviewers } : {}),
  };
}

function mergeNotes(...parts: Array<string | undefined>): string | undefined {
  let merged = "";
  for (const part of parts) {
    const next = part?.trim();
    if (!next || merged.includes(next)) continue;
    merged = merged ? `${merged}\n\n${next}` : next;
  }
  return merged.slice(0, 4000) || undefined;
}

function emitDetails(
  onDetails: RunWikiInput["onDetails"],
  patch: Partial<WikiProduceToolDetails>,
): void {
  try {
    onDetails?.(patch);
  } catch {
    // display must not break the run
  }
}

/**
 * One complete Wiki Run. Tool adapter maps progress/details to Pi onUpdate.
 */
export async function runWiki(input: RunWikiInput): Promise<RunWikiResult> {
  let runId: string | undefined;
  let workspace = input.workspace;
  /** Single source of truth for job phase; record/tool statuses are projections. */
  let phase: WikiRunPhase = "freezing";
  let details: WikiProduceToolDetails = {
    status: toolStatusFromPhase(phase),
  };

  const patch = (p: Partial<WikiProduceToolDetails>) => {
    details = { ...details, ...p };
    emitDetails(input.onDetails, p);
  };

  /** Advance phase and project tool status from the phase enum only. */
  const setPhase = (
    next: WikiRunPhase,
    extra?: Omit<Partial<WikiProduceToolDetails>, "status">,
  ) => {
    phase = next;
    patch({
      ...extra,
      status: toolStatusFromPhase(phase),
    });
  };

  /**
   * Live Run Graph via pure AttemptJournal + GraphStore port.
   * SSE/tool details and durable analysis/run-graph.json share journal.snapshot().
   */
  const journal = new AttemptJournal();
  /** Injected store wins; otherwise created on first topology publish. */
  let graphStore: GraphStore | undefined = input.graphStore;
  let graphRunId: string | undefined;

  /**
   * Orchestration always emits through ProgressSink.
   * Tool edge keeps onProgress; we adapt it here (or accept an explicit sink).
   */
  const progressSink: ProgressSink =
    input.progressSink ?? progressSinkFromCallback(input.onProgress);

  const persistLiveGraph = async (): Promise<void> => {
    if (!graphStore || !graphRunId) return;
    try {
      await graphStore.save(graphRunId, journal.snapshot());
    } catch {
      // Durable graph is best-effort; live projection already emitted.
    }
  };

  /** Fold progress into journal, then fan out to tool/SSE subscribers via ProgressSink. */
  const handleProgress = (progress: ProduceProgress): void => {
    switch (progress.kind) {
      case "attempt":
        journal.upsert(progress.attempt);
        break;
      case "topology":
        journal.setTopology(
          progress.topology,
          progress.topologyVersion ?? Math.max(1, journal.snapshot().topologyVersion + 1),
        );
        break;
      case "graph":
        for (const a of progress.graph.attempts) journal.upsert(a);
        if (progress.graph.topology.length > 0) {
          journal.setTopology(progress.graph.topology, progress.graph.topologyVersion);
        }
        break;
      default:
        break;
    }
    // Always re-emit graph snapshot for live details after journal updates.
    if (progress.kind === "attempt" || progress.kind === "topology" || progress.kind === "graph") {
      progressSink.emit({ kind: "graph", graph: journal.snapshot() });
    }
    progressSink.emit(progress);
  };

  /** Emit Spec topology into journal and persist via GraphStore. */
  const publishTopology = async (committed: WikiRunSpec, rid: string, root: string) => {
    graphStore = graphStore ?? createCoreGraphStore(root);
    graphRunId = rid;
    const topology = topologyFromSpec(committed);
    // No explicit version: handleProgress bumps from the journal snapshot, so
    // a replanned topology publishes as v2, v3, … instead of re-stamping v1.
    handleProgress({ kind: "topology", topology });
    await persistLiveGraph();
  };

  setPhase("freezing", {
    summary: "Freezing Repository Snapshot Set and Producer Skill",
  });

  try {
    throwIfAborted(input.abortSignal);
    workspace = input.resolveWorkspace ? await input.resolveWorkspace() : input.workspace;
    throwIfAborted(input.abortSignal);

    const fixture = input.fixture ?? shouldUsePiFixtureMode({});
    const runtime = resolveProduceRuntime({
      fixture,
      runtime: input.runtime,
      defaults: { timeoutMs: requestTimeoutMs(workspace) },
    });
    const freezeFn = input.freeze ?? freezeWikiRun;
    const publishFn = input.publish ?? publishStagingToPublication;

    const frozen = await freezeFn({
      workspace,
      sessionId: input.sessionId,
      autoApprove: input.autoApprove === true,
    });
    runId = frozen.runId;
    const layout = layoutFromFrozen(frozen);
    const models = await resolveModels(input.resolveModel, fixture, workspace);
    const operatorNotes = input.notes?.trim();

    const runPlanner = async (
      priorSpec?: WikiRunSpec,
      revisionFeedback?: string,
    ): Promise<WikiRunSpec> => {
      setPhase("planning", {
        runId,
        summary: priorSpec
          ? "Re-planning WikiRunSpec from frozen sources"
          : "Planning WikiRunSpec from frozen sources",
      });
      const planned = await planWikiSpec({
        layout,
        workspaceName: workspace.name,
        wikiLanguage: workspace.wikiLanguage,
        runtime,
        model: models.planner?.model ?? models.writer?.model,
        modelRuntime: models.planner?.modelRuntime ?? models.writer?.modelRuntime,
        maxContextTokens: models.planner?.maxContextTokens ?? models.writer?.maxContextTokens,
        // Scouts prefer worker economics when configured.
        scoutModel: models.worker?.model ?? models.planner?.model ?? models.writer?.model,
        scoutModelRuntime:
          models.worker?.modelRuntime ??
          models.planner?.modelRuntime ??
          models.writer?.modelRuntime,
        scoutMaxContextTokens:
          models.worker?.maxContextTokens ??
          models.planner?.maxContextTokens ??
          models.writer?.maxContextTokens,
        contextTargetTokens: workspace.limits?.contextTargetTokens,
        sourceIgnores: frozen.sourceIgnores,
        abortSignal: input.abortSignal,
        operatorNotes,
        priorSpec,
        revisionFeedback,
        orchestration: resolveOrchestration(workspace),
        customTools: input.createPlanTools?.(layout.runWorkDir),
        onProgress: (attempt) => handleProgress({ kind: "attempt", attempt }),
      });
      const feedback = revisionFeedback?.trim();
      return WikiRunSpecSchema.parse({
        ...planned.spec,
        notes: mergeNotes(
          planned.spec.notes?.trim(),
          operatorNotes,
          feedback ? `Operator revision feedback:\n${feedback}` : undefined,
        ),
        changelog: [
          ...planned.spec.changelog,
          ...(operatorNotes && !priorSpec ? ["Operator notes supplied to wiki_produce"] : []),
          ...(priorSpec ? ["Planner re-ran after operator revision"] : []),
        ].slice(-40),
      });
    };

    let spec = await runPlanner();
    await commitSpec(workspace.rootPath, runId, spec);
    await publishTopology(spec, runId, workspace.rootPath);

    const patchRunRecord = (patch: Parameters<typeof updateRunRecord>[2]) =>
      updateRunRecord(workspace.rootPath, runId!, patch);

    // planConfirm defaults ON (schema default true — HITL plan approval);
    // `=== true` keeps this consistent with session_status even for unparsed
    // workspace objects.
    const requirePlanGate = input.autoApprove !== true && workspace.planConfirm === true;
    if (requirePlanGate) {
      const planGate = await runPlanGateLoop({
        coordinator: input.gateCoordinator,
        toolCallId: input.toolCallId,
        runId,
        signal: input.abortSignal,
        initialSpec: spec,
        runPlanner,
        commitSpec: (next) => commitSpec(workspace.rootPath, runId!, next),
        publishTopology: (next) => publishTopology(next, runId!, workspace.rootPath),
        setPhase,
        updateRunRecord: patchRunRecord,
      });
      spec = planGate.spec;
      if (planGate.action === "declined") {
        await persistLiveGraph();
        return {
          ...details,
          status: toolStatusFromPhase(phase),
          summary: "WikiRunSpec declined by operator",
        };
      }
    }

    setPhase("producing", {
      runId,
      spec,
      summary: "Producing and reviewing Wiki",
    });
    await updateRunRecord(workspace.rootPath, runId, {
      status: recordStatusFromPhase(phase),
      spec,
      summary: "Producing Wiki",
    });

    const produced = await produceWiki({
      runId,
      workspace,
      layout,
      spec,
      runtime,
      abortSignal: input.abortSignal,
      models,
      maxContextTokens: models.writer?.maxContextTokens,
      contextTargetTokens: workspace.limits?.contextTargetTokens,
      additionalSkillPaths: [frozen.skillPath],
      sourceIgnores: frozen.sourceIgnores,
      onProgress: handleProgress,
    });
    // Phase boundary: durable graph after produce body (topology + all attempts).
    await persistLiveGraph();

    if (produced.status === "cancelled") throw abortError();
    if (produced.status === "failed" || !produced.publishability.publishable) {
      const summary = produced.summary || produced.publishability.reasons.join("; ");
      setPhase("failed", {
        spec: produced.spec,
        pages: produced.pages,
        summary,
        defects: produced.defects,
      });
      await updateRunRecord(workspace.rootPath, runId, {
        status: recordStatusFromPhase(phase),
        spec: produced.spec,
        pages: produced.pages,
        summary,
        error: summary,
      });
      await persistLiveGraph();
      return {
        ...details,
        status: toolStatusFromPhase(phase),
        spec: produced.spec,
        pages: produced.pages,
        summary,
        defects: produced.defects,
      };
    }

    const pages = produced.pages;
    spec = produced.spec;
    if (input.autoApprove !== true) {
      const pubGate = await runPublicationGateLoop({
        coordinator: input.gateCoordinator,
        toolCallId: input.toolCallId,
        runId,
        signal: input.abortSignal,
        spec,
        pages,
        recordSummary: produced.summary,
        defects: produced.defects ?? undefined,
        setPhase,
        updateRunRecord: patchRunRecord,
      });
      if (pubGate.action === "declined") {
        await persistLiveGraph();
        return {
          ...details,
          status: toolStatusFromPhase(phase),
          summary: "Publication declined; Staging Wiki retained",
        };
      }
    }

    throwIfAborted(input.abortSignal);
    const publicationPath = workspace.publicationPath ?? path.join(workspace.rootPath, "wiki");
    // OKF v0.2 provenance is Run Boundary-owned: actor from the writer model,
    // timestamps from publish time, verified only for a clean review council.
    const writerModelId = workspace.roleModels?.writer?.id ?? workspace.model.id;
    const publishedAt = new Date().toISOString();
    await publishFn({
      stagingDir: produced.layout.wikiDir,
      publicationPath,
      runId,
      sources: frozen.sources.map((source) => ({ id: source.id, path: source.path })),
      stamp: {
        generatedBy: `okf-wiki/${writerModelId}`,
        generatedAt: publishedAt,
        ...(produced.defects?.clean === true
          ? { verified: [{ by: "process:review-council", at: publishedAt }] }
          : {}),
      },
    });
    setPhase("published", {
      runId,
      spec,
      pages,
      summary: produced.summary,
      defects: produced.defects,
    });
    await updateRunRecord(workspace.rootPath, runId, {
      status: recordStatusFromPhase(phase),
      spec,
      pages,
      summary: produced.summary,
      error: null,
    });
    await persistLiveGraph();
    return {
      ...details,
      status: toolStatusFromPhase(phase),
      runId,
      spec,
      pages,
      summary: produced.summary,
      defects: produced.defects,
    };
  } catch (error) {
    // Only explicit signals count as cancellation (abort signal or AbortError
    // from our own gate/abort paths). Matching message text would misfile real
    // provider failures that merely mention "cancel".
    const cancelled =
      input.abortSignal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError");
    const message = cancelled
      ? "Wiki Run cancelled"
      : redactErrorMessage(error instanceof Error ? error.message : String(error));
    setPhase(cancelled ? "cancelled" : "failed", { summary: message });
    if (runId) {
      await updateRunRecord(workspace.rootPath, runId, {
        status: recordStatusFromPhase(phase),
        summary: message,
        error: cancelled ? null : message,
      }).catch(() => undefined);
    }
    await persistLiveGraph();
    return {
      ...details,
      ...(runId ? { runId } : {}),
      status: toolStatusFromPhase(phase),
      summary: message,
    };
  }
}

/** Alias: GatePort is the DIP name; coordinator kept for tool/server call sites. */
