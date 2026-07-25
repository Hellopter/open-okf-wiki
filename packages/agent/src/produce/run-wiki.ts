/**
 * Deep Wiki Run shell (ADR 0032): freeze → plan → gates → produce → publish.
 *
 * wiki_produce tool is a thin Pi adapter over this module.
 * Inject freeze/publish/runtime for tests — not compatibility shims.
 */

import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type WikiProduceToolDetails,
  type WikiRunSpec,
  WikiRunSpecSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  freezeWikiRun,
  type FrozenRunBoundary,
  publishStagingToPublication,
  updateRunRecord,
} from "@okf-wiki/core";
import { layoutFromFrozen } from "../pi/run-workdir.js";
import { redactErrorMessage } from "../run-redact.js";
import { shouldUsePiFixtureMode } from "./fixture-mode.js";
import { commitSpec } from "./living-spec.js";
import { planWikiSpec } from "./plan.js";
import type { ProduceProgress } from "./progress.js";
import {
  type ProduceRuntime,
  resolveProduceRuntime,
} from "./produce-runtime.js";
import { produceWiki } from "./produce-wiki.js";

export type WikiProduceModelRole = "writer" | "planner" | "worker" | "reviewer";

export type WikiProduceModelFactory = (
  role: WikiProduceModelRole,
  workspace: WorkspaceConfig,
) => Promise<{
  model: Model<any>;
  modelRuntime?: ModelRuntime;
  maxContextTokens?: number;
}>;

export type WikiProduceGateDecision = {
  action: "approve" | "deny" | "revise";
  feedback?: string;
  spec?: WikiRunSpec;
};

export type WikiProduceGateRequest = {
  toolCallId: string;
  runId: string;
  gate: "plan" | "publication";
  spec: WikiRunSpec;
  pages: string[];
};

export type WikiProduceGateCoordinator = {
  waitForDecision(
    request: WikiProduceGateRequest,
    signal?: AbortSignal,
  ): Promise<WikiProduceGateDecision>;
};

export type RunWikiInput = {
  workspace: WorkspaceConfig;
  /** Resolve once at execute so long-lived sessions see saved Workspace edits. */
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  toolCallId: string;
  notes?: string;
  autoApprove?: boolean;
  gateCoordinator: WikiProduceGateCoordinator;
  resolveModel?: WikiProduceModelFactory;
  /** Explicit fixture path for tests. */
  fixture?: boolean;
  runtime?: ProduceRuntime;
  freeze?: (input: {
    workspace: WorkspaceConfig;
    sessionId: string;
    autoApprove?: boolean;
  }) => Promise<FrozenRunBoundary>;
  publish?: typeof publishStagingToPublication;
  abortSignal?: AbortSignal;
  onProgress?: (progress: ProduceProgress) => void;
  /** Low-level status patches for gate/record (tool maps to details). */
  onDetails?: (patch: Partial<WikiProduceToolDetails>) => void;
};

export type RunWikiResult = WikiProduceToolDetails;

function abortError(): Error {
  const error = new Error("Wiki Run cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function awaitGate(
  coordinator: WikiProduceGateCoordinator,
  request: WikiProduceGateRequest,
  signal?: AbortSignal,
): Promise<WikiProduceGateDecision> {
  throwIfAborted(signal);
  if (!signal) return coordinator.waitForDecision(request);
  return new Promise<WikiProduceGateDecision>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void coordinator.waitForDecision(request, signal).then(
      (decision) => {
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolveModels(
  factory: WikiProduceModelFactory | undefined,
  fixture: boolean,
  workspace: WorkspaceConfig,
) {
  if (fixture) return {};
  if (!factory) {
    throw new Error("Live wiki_produce requires a model resolver");
  }
  const writer = await factory("writer", workspace);
  const [planner, worker, reviewer] = await Promise.all([
    factory("planner", workspace).catch(() => writer),
    factory("worker", workspace).catch(() => writer),
    factory("reviewer", workspace).catch(() => writer),
  ]);
  return { writer, planner, worker, reviewer };
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
  let details: WikiProduceToolDetails = { status: "freezing" };
  const patch = (p: Partial<WikiProduceToolDetails>) => {
    details = { ...details, ...p };
    emitDetails(input.onDetails, p);
  };
  const onChild = (span: NonNullable<WikiProduceToolDetails["children"]>[number]) => {
    input.onProgress?.({ kind: "child", span });
  };

  patch({
    status: "freezing",
    summary: "Freezing Repository Snapshot Set and Producer Skill",
  });

  try {
    throwIfAborted(input.abortSignal);
    workspace = input.resolveWorkspace ? await input.resolveWorkspace() : input.workspace;
    throwIfAborted(input.abortSignal);

    const fixture = input.fixture ?? shouldUsePiFixtureMode({});
    const runtime = resolveProduceRuntime({ fixture, runtime: input.runtime });
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
      patch({
        runId,
        status: "planning",
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
        contextTargetTokens: workspace.limits?.contextTargetTokens,
        sourceIgnores: frozen.sourceIgnores,
        abortSignal: input.abortSignal,
        operatorNotes,
        priorSpec,
        revisionFeedback,
        onProgress: onChild,
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

    const requirePlanGate = input.autoApprove !== true && workspace.planConfirm !== false;
    if (requirePlanGate) {
      for (;;) {
        await updateRunRecord(workspace.rootPath, runId, {
          status: "awaiting_plan",
          spec,
          summary: "Awaiting WikiRunSpec approval",
        });
        patch({
          status: "awaiting_plan",
          spec,
          summary: "Awaiting WikiRunSpec approval",
        });
        const decision = await awaitGate(
          input.gateCoordinator,
          {
            toolCallId: input.toolCallId,
            runId,
            gate: "plan",
            spec,
            pages: [],
          },
          input.abortSignal,
        );
        if (decision.action === "deny") {
          await updateRunRecord(workspace.rootPath, runId, {
            status: "cancelled",
            spec,
            summary: "WikiRunSpec declined by operator",
          });
          return {
            ...details,
            status: "cancelled",
            summary: "WikiRunSpec declined by operator",
          };
        }
        if (decision.action === "revise") {
          const prior = decision.spec ? WikiRunSpecSchema.parse(decision.spec) : spec;
          spec = await runPlanner(
            prior,
            decision.feedback?.trim() || "Re-evaluate the WikiRunSpec against frozen sources.",
          );
          await commitSpec(workspace.rootPath, runId, spec);
          continue;
        }
        if (decision.spec) {
          spec = WikiRunSpecSchema.parse(decision.spec);
          await commitSpec(workspace.rootPath, runId, spec);
        }
        break;
      }
    }

    await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      spec,
      summary: "Producing Wiki",
    });
    patch({
      status: "producing",
      spec,
      summary: "Producing and reviewing Wiki",
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
      onProgress: input.onProgress,
    });

    if (produced.status === "cancelled") throw abortError();
    if (produced.status === "failed" || !produced.publishability.publishable) {
      const summary = produced.summary || produced.publishability.reasons.join("; ");
      await updateRunRecord(workspace.rootPath, runId, {
        status: "failed",
        spec: produced.spec,
        pages: produced.pages,
        summary,
        error: summary,
      });
      return {
        ...details,
        status: "failed",
        spec: produced.spec,
        pages: produced.pages,
        summary,
        defects: produced.defects,
      };
    }

    const pages = produced.pages;
    spec = produced.spec;
    if (input.autoApprove !== true) {
      await updateRunRecord(workspace.rootPath, runId, {
        status: "awaiting_publication",
        spec,
        pages,
        summary: produced.summary,
      });
      patch({
        status: "awaiting_publication",
        spec,
        pages,
        summary: "Awaiting publication approval",
        defects: produced.defects ?? undefined,
      });
      const decision = await awaitGate(
        input.gateCoordinator,
        {
          toolCallId: input.toolCallId,
          runId,
          gate: "publication",
          spec,
          pages,
        },
        input.abortSignal,
      );
      if (decision.action !== "approve") {
        await updateRunRecord(workspace.rootPath, runId, {
          status: "publication_declined",
          spec,
          pages,
          summary: "Publication declined; Staging Wiki retained",
        });
        return {
          ...details,
          status: "publication_declined",
          summary: "Publication declined; Staging Wiki retained",
        };
      }
    }

    throwIfAborted(input.abortSignal);
    const publicationPath = workspace.publicationPath ?? path.join(workspace.rootPath, "wiki");
    await publishFn({
      stagingDir: produced.layout.wikiDir,
      publicationPath,
      runId,
      sources: frozen.sources.map((source) => ({ id: source.id, path: source.path })),
    });
    await updateRunRecord(workspace.rootPath, runId, {
      status: "published",
      spec,
      pages,
      summary: produced.summary,
      error: null,
    });
    return {
      ...details,
      status: "published",
      runId,
      spec,
      pages,
      summary: produced.summary,
      defects: produced.defects,
    };
  } catch (error) {
    const cancelled =
      input.abortSignal?.aborted === true ||
      (error instanceof Error &&
        (error.name === "AbortError" || /cancel/i.test(error.message)));
    const message = cancelled
      ? "Wiki Run cancelled"
      : redactErrorMessage(error instanceof Error ? error.message : String(error));
    if (runId) {
      await updateRunRecord(workspace.rootPath, runId, {
        status: cancelled ? "cancelled" : "failed",
        summary: message,
        error: cancelled ? null : message,
      }).catch(() => undefined);
    }
    return {
      ...details,
      ...(runId ? { runId } : {}),
      status: cancelled ? "cancelled" : "failed",
      summary: message,
    };
  }
}
