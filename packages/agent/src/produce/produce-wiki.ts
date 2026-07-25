/**
 * Deep Produce module (Layer B Semantic Workflow body, ADR 0028 / 0030).
 *
 * Approved Spec (already committed) → Domain/Leaf research + receipts →
 * root_write → review council → repair* → scorePublishable.
 *
 * Requires ProduceRuntime. Does not write Spec (living-spec / runWiki owns that).
 * Emits ProduceProgress only — tool edge projects to WikiProduceToolDetails.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { MergedDefectReport, WikiRunSpec, WorkspaceConfig } from "@okf-wiki/contract";
import { resolveOrchestration } from "../limits.js";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { type ProduceRuntime, type ProduceWriteResult } from "./produce-runtime.js";
import { emitProduceProgress, type ProduceProgress } from "./progress.js";
import {
  domainResearchPrompt,
  leafResearchPrompt,
  reviewerPrompt,
  rootWritePrompt,
  rootWriteSystemPrompt,
} from "./prompts.js";
import {
  type PublishabilityResult,
  scorePublishable,
  sourcesFromMounts,
} from "./publishability.js";
import { attachResearchReceipt, buildReceiptIndex } from "./receipts.js";
import { runReviewCouncil } from "./review.js";
import type { ScopedAgentProgress } from "./run-scoped-agent.js";
import { listWikiMarkdown } from "./wiki-pages.js";

export type ProduceWikiModels = {
  writer?: {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
  worker?: {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
  reviewer?: {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
};

export type ProduceWikiInput = {
  runId: string;
  workspace: WorkspaceConfig;
  layout: RunWorkdirLayout;
  /** Already-approved and committed living Spec. */
  spec: WikiRunSpec;
  /** Required: selected once at runWiki / test harness. */
  runtime: ProduceRuntime;
  models?: ProduceWikiModels;
  abortSignal?: AbortSignal;
  additionalSkillPaths?: readonly string[];
  maxContextTokens?: number;
  contextTargetTokens?: number;
  onProgress?: (progress: ProduceProgress) => void;
  sourceIgnores?: SourceIgnoreInput;
};

export type ProduceWikiResult = {
  status: "ready_for_publish" | "failed" | "cancelled";
  pages: string[];
  summary: string;
  spec: WikiRunSpec;
  defects: MergedDefectReport | null;
  publishability: PublishabilityResult;
  layout: RunWorkdirLayout;
  mode: "fixture" | "live";
  metrics: {
    domainStarts: number;
    leafStarts: number;
    repairRounds: number;
  };
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

function emit(onProgress: ProduceWikiInput["onProgress"], progress: ProduceProgress): void {
  emitProduceProgress(onProgress, progress);
}

async function emitPagesFromDisk(
  onProgress: ProduceWikiInput["onProgress"],
  wikiDir: string,
  spec: WikiRunSpec,
): Promise<void> {
  const existing = new Set(await listWikiMarkdown(wikiDir));
  const done = (spec.pages ?? [])
    .map((p) => p.path)
    .filter((pagePath) => existing.has(pagePath.replace(/^\.?\//, "")));
  emit(onProgress, { kind: "pages", pages: done });
}

/**
 * Layer B Produce: research → write → council → repair → hard score.
 */
export async function produceWiki(input: ProduceWikiInput): Promise<ProduceWikiResult> {
  const onProgress = input.onProgress;
  const orch = resolveOrchestration(input.workspace);
  const runtime = input.runtime;
  const metrics = { domainStarts: 0, leafStarts: 0, repairRounds: 0 };
  const multiSource = (input.workspace.sources?.length ?? 0) > 1;
  const wikiLanguage = input.workspace.wikiLanguage ?? "en";
  const contextTargetTokens =
    input.contextTargetTokens ?? input.workspace.limits?.contextTargetTokens;
  const { layout, spec } = input;
  const mode: "fixture" | "live" = runtime.kind;

  if (input.abortSignal?.aborted) {
    return cancelledResult(spec, mode, metrics, layout);
  }

  try {
    return await produceWikiBody({
      input,
      onProgress,
      orch,
      runtime,
      metrics,
      multiSource,
      wikiLanguage,
      contextTargetTokens,
      layout,
      spec,
      mode,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(spec, mode, metrics, layout);
    }
    throw err;
  }
}

async function produceWikiBody(ctx: {
  input: ProduceWikiInput;
  onProgress: ProduceWikiInput["onProgress"];
  orch: ReturnType<typeof resolveOrchestration>;
  runtime: ProduceRuntime;
  metrics: ProduceWikiResult["metrics"];
  multiSource: boolean;
  wikiLanguage: "en" | "zh";
  contextTargetTokens: number | undefined;
  layout: RunWorkdirLayout;
  spec: WikiRunSpec;
  mode: "fixture" | "live";
}): Promise<ProduceWikiResult> {
  const {
    input,
    onProgress,
    orch,
    runtime,
    metrics,
    multiSource,
    wikiLanguage,
    contextTargetTokens,
    layout,
    spec,
    mode,
  } = ctx;

  // Spec must already be committed by runWiki (living-spec). Produce only reads it.
  await emitPagesFromDisk(onProgress, layout.wikiDir, spec);

  const criticalDomainFailures: string[] = [];
  emit(onProgress, {
    kind: "status",
    status: "producing",
    summary: "domain + leaf research",
  });
  const domains = (spec.domains ?? []).slice(0, orch.maxDomainFanOut);
  const workerModel = input.models?.worker ?? input.models?.writer;

  for (const d of domains) {
    throwIfAborted(input.abortSignal);
    metrics.domainStarts += 1;
    const domainNodeId = `domain-${d.id}`;

    const leafQuestions = (d.questions ?? []).slice(0, orch.maxLeafFanOut);
    const childReceiptPaths: string[] = [];

    if (leafQuestions.length > 0 && orch.maxDepth >= 2) {
      const leafTasks = leafQuestions.map((q, li) => {
        metrics.leafStarts += 1;
        const leafNodeId = `leaf-${d.id}-${li + 1}`;
        return {
          leafNodeId,
          input: {
            role: "leaf" as const,
            spanId: leafNodeId,
            runWorkDir: layout.runWorkDir,
            task: leafResearchPrompt({
              domainId: d.id,
              question: q,
              scope: d.scope ?? "",
              nodeId: leafNodeId,
              runId: input.runId,
            }),
            model: workerModel?.model,
            modelRuntime: workerModel?.modelRuntime,
            maxContextTokens: workerModel?.maxContextTokens,
            contextTargetTokens,
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: (span: ScopedAgentProgress) => emit(onProgress, { kind: "child", span }),
          },
        };
      });

      try {
        const leafResults = await runtime.runAgentsParallel(
          leafTasks.map((t) => t.input),
          { concurrency: Math.min(2, leafTasks.length) },
        );
        for (let i = 0; i < leafResults.length; i++) {
          const leafNodeId = leafTasks[i]!.leafNodeId;
          const lr = leafResults[i]!;
          const withPath = await attachResearchReceipt(
            {
              role: lr.role,
              mode: lr.mode,
              summary: lr.summary,
            },
            {
              workspaceRoot: input.workspace.rootPath,
              runId: input.runId,
              nodeId: leafNodeId,
              parentId: domainNodeId,
              scope: `${d.id}: ${leafQuestions[i]}`,
              status: "complete",
            },
          );
          childReceiptPaths.push(withPath.receiptPath);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return cancelledResult(spec, mode, metrics, layout);
        }
      }
    }

    try {
      const domainResult = await runtime.runAgent({
        role: "domain",
        spanId: domainNodeId,
        runWorkDir: layout.runWorkDir,
        task: domainResearchPrompt({
          domainId: d.id,
          title: d.title ?? d.id,
          scope: d.scope ?? "",
          questions: d.questions ?? [],
          nodeId: domainNodeId,
          runId: input.runId,
        }),
        model: workerModel?.model,
        modelRuntime: workerModel?.modelRuntime,
        maxContextTokens: workerModel?.maxContextTokens,
        contextTargetTokens,
        sourceIgnores: input.sourceIgnores,
        abortSignal: input.abortSignal,
        onProgress: (span) => emit(onProgress, { kind: "child", span }),
      });
      await attachResearchReceipt(
        {
          role: domainResult.role,
          mode: domainResult.mode,
          summary: domainResult.summary,
        },
        {
          workspaceRoot: input.workspace.rootPath,
          runId: input.runId,
          nodeId: domainNodeId,
          parentId: "root",
          scope: d.scope ?? d.title ?? d.id,
          status: "complete",
          childReceipts: childReceiptPaths,
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return cancelledResult(spec, mode, metrics, layout);
      }
      const msg = err instanceof Error ? err.message : String(err);
      await attachResearchReceipt(
        { role: "domain", mode, summary: `FAILED: ${msg}` },
        {
          workspaceRoot: input.workspace.rootPath,
          runId: input.runId,
          nodeId: domainNodeId,
          parentId: "root",
          scope: d.scope ?? d.title ?? d.id,
          status: "failed",
          childReceipts: childReceiptPaths,
          summary: `FAILED: ${msg}`,
        },
      );
      if (d.critical !== false) {
        criticalDomainFailures.push(`${d.id}: ${msg}`);
      }
    }
  }

  if (criticalDomainFailures.length > 0) {
    emit(onProgress, {
      kind: "status",
      status: "producing",
      summary: `critical domain research failed: ${criticalDomainFailures[0]}`,
    });
    return {
      status: "failed",
      pages: [],
      summary: `Critical domain research failed: ${criticalDomainFailures.join("; ")}`,
      spec,
      defects: null,
      publishability: {
        publishable: false,
        reasons: criticalDomainFailures.map((f) => `domain: ${f}`),
        pages: [],
        defects: null,
      },
      layout,
      mode,
      metrics,
    };
  }

  // Root write
  throwIfAborted(input.abortSignal);
  emit(onProgress, { kind: "status", status: "producing", summary: "root_write" });
  const receiptIndex = await buildReceiptIndex(input.workspace.rootPath, input.runId);
  let produced: ProduceWriteResult;
  try {
    produced = await runtime.writeWiki({
      layout,
      spec,
      workspaceName: input.workspace.name,
      model: input.models?.writer?.model,
      modelRuntime: input.models?.writer?.modelRuntime,
      maxContextTokens: input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
      contextTargetTokens,
      additionalSkillPaths: input.additionalSkillPaths,
      sourceIgnores: input.sourceIgnores,
      abortSignal: input.abortSignal,
      systemPrompt: rootWriteSystemPrompt(),
      task: rootWritePrompt({
        layout,
        spec,
        wikiLanguage,
        multiSource,
        receiptIndex,
      }),
      onProgress: (span) => emit(onProgress, { kind: "child", span }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(spec, mode, metrics, layout);
    }
    throw err;
  }

  await emitPagesFromDisk(onProgress, produced.layout.wikiDir, spec);
  emit(onProgress, {
    kind: "status",
    status: "producing",
    summary: `root_write complete (${produced.pages.length} pages)`,
  });
  emit(onProgress, { kind: "pages", pages: produced.pages });

  // Review + repair
  let defects: MergedDefectReport | null = null;
  const maxRepair = Math.max(0, spec.acceptance?.maxRepairRounds ?? 2);
  const councilSize = Math.max(1, orch.reviewCouncilSize ?? 1);
  const lenses = ["grounding", "coverage", "consistency", "general"] as const;

  for (let round = 1; round <= maxRepair + 1; round++) {
    throwIfAborted(input.abortSignal);
    emit(onProgress, {
      kind: "status",
      status: "producing",
      summary: `review council round ${round}`,
    });

    const reviewers: Array<{ id: string; text: string }> = [];

    if (runtime.kind === "live" && !input.models?.reviewer?.model) {
      // Fail closed: do not pretend the council is clean without a reviewer model.
      // Fence the DefectReport JSON so parseDefectReportFromText preserves code.
      const msg = "Live Produce requires a reviewer model (or use fixture runtime)";
      reviewers.push({
        id: "reviewer-1",
        text: [
          "```json",
          JSON.stringify({
            clean: false,
            defects: [
              {
                severity: "blocking",
                code: "reviewer_missing",
                issue: msg,
              },
            ],
            summary: msg,
          }),
          "```",
        ].join("\n"),
      });
    } else {
      for (let i = 0; i < councilSize; i++) {
        const reviewerId = `reviewer-${i + 1}`;
        const lens = lenses[i % lenses.length]!;
        try {
          const child = await runtime.runAgent({
            role: "reviewer",
            spanId: `${reviewerId}-${lens}`,
            runWorkDir: layout.runWorkDir,
            task: reviewerPrompt({ pages: produced.pages, lens }),
            model: input.models?.reviewer?.model,
            modelRuntime: input.models?.reviewer?.modelRuntime,
            maxContextTokens: input.models?.reviewer?.maxContextTokens,
            contextTargetTokens,
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: (span) => emit(onProgress, { kind: "child", span }),
          });
          reviewers.push({ id: reviewerId, text: child.summary });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return cancelledResult(spec, mode, metrics, layout, produced);
          }
          const msg = err instanceof Error ? err.message : String(err);
          reviewers.push({
            id: reviewerId,
            text: JSON.stringify({
              clean: false,
              defects: [
                {
                  severity: "blocking",
                  code: "reviewer_error",
                  issue: `Reviewer failed: ${msg}`,
                },
              ],
              summary: `reviewer error: ${msg}`,
            }),
          });
        }
      }
    }

    defects = await runReviewCouncil({
      reviewers,
      pages: produced.pages,
      workspaceRoot: input.workspace.rootPath,
      runId: input.runId,
      round,
    });
    emit(onProgress, {
      kind: "defects",
      defects,
      summary: defects.summary ?? `Review round ${round}: ${defects.defects.length} defect(s)`,
    });

    const blocking = (spec.acceptance?.blockingSeverities ?? ["blocking"]) as string[];
    const hasBlocking = defects.defects.some((d) => blocking.includes(d.severity));
    if (defects.clean || !hasBlocking) {
      break;
    }
    if (round > maxRepair) {
      break;
    }

    metrics.repairRounds += 1;
    emit(onProgress, {
      kind: "status",
      status: "producing",
      summary: `repair round ${metrics.repairRounds} (${defects.defects.length} defects)`,
    });
    const defectText = defects.defects
      .map((d) => `- [${d.severity}] ${d.path ?? "?"} ${d.code ?? ""}: ${d.issue}`)
      .join("\n");
    try {
      produced = await runtime.writeWiki({
        layout,
        spec,
        workspaceName: input.workspace.name,
        model: input.models?.writer?.model,
        modelRuntime: input.models?.writer?.modelRuntime,
        maxContextTokens: input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
        contextTargetTokens,
        additionalSkillPaths: input.additionalSkillPaths,
        sourceIgnores: input.sourceIgnores,
        abortSignal: input.abortSignal,
        systemPrompt: rootWriteSystemPrompt(),
        task: rootWritePrompt({
          layout,
          spec,
          wikiLanguage,
          multiSource,
          receiptIndex,
          repairDefects: defectText,
        }),
        onProgress: (span) => emit(onProgress, { kind: "child", span }),
      });
      await emitPagesFromDisk(onProgress, produced.layout.wikiDir, spec);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return cancelledResult(spec, mode, metrics, layout, produced);
      }
      throw err;
    }
  }

  const sources = sourcesFromMounts(layout.sourceMounts);
  const publishability = await scorePublishable({
    wikiRoot: produced.layout.wikiDir,
    workspaceRoot: input.workspace.rootPath,
    runId: input.runId,
    sources,
    spec,
    requireReviewReceipt: true,
  });

  if (!publishability.publishable) {
    emit(onProgress, {
      kind: "status",
      status: "producing",
      summary: publishability.reasons.slice(0, 3).join("; "),
    });
    if (defects) {
      emit(onProgress, { kind: "defects", defects });
    }
    return {
      status: "failed",
      pages: produced.pages,
      summary: `Produce failed hard-validate: ${publishability.reasons.slice(0, 5).join("; ")}`,
      spec,
      defects,
      publishability,
      layout: produced.layout,
      mode: produced.mode,
      metrics,
    };
  }

  emit(onProgress, {
    kind: "status",
    status: "producing",
    summary: produced.summary,
  });
  emit(onProgress, { kind: "pages", pages: produced.pages });

  return {
    status: "ready_for_publish",
    pages: produced.pages,
    summary: produced.summary,
    spec,
    defects,
    publishability,
    layout: produced.layout,
    mode: produced.mode,
    metrics,
  };
}

function cancelledResult(
  spec: WikiRunSpec,
  mode: "fixture" | "live",
  metrics: ProduceWikiResult["metrics"],
  layout: RunWorkdirLayout,
  produced?: ProduceWriteResult,
): ProduceWikiResult {
  const emptyPub: PublishabilityResult = {
    publishable: false,
    reasons: ["cancelled"],
    pages: produced?.pages ?? [],
    defects: null,
  };
  return {
    status: "cancelled",
    pages: produced?.pages ?? [],
    summary: "Wiki Run cancelled",
    spec,
    defects: null,
    publishability: emptyPub,
    layout: produced?.layout ?? layout,
    mode,
    metrics,
  };
}
