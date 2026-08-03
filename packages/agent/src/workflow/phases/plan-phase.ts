/**
 * Planner: living WikiRunSpec via AgentRunner (or default Spec for fixture).
 * Path-first handoff: prefer analysis/plan-draft.json from submit_wiki_run_spec;
 * fail-closed when draft is missing — no invented thin plans / chat JSON spill.
 *
 * Hybrid plan scouts + bounded re-scout when assertCoverage finds gaps
 * (planRescoutMaxRounds). Only this synthesizer may submit the Spec.
 *
 * Workflow stays free of Pi SDK and tools/: live callers inject customTools
 * (submit_wiki_run_spec) via PlanWikiSpecInput.customTools.
 */

import {
  assertCoverage,
  type AttemptItem,
  type AttemptMetrics,
  type CoveragePlan,
  type CoverageResult,
  CoverageAssertError,
  DEFAULT_ORCHESTRATION,
  defaultWikiRunSpec,
  type NodeAttempt,
  type RetryLimits,
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
  type WikiRunSpec,
  type WorkspaceOrchestration,
} from "@okf-wiki/contract";
import type {
  AgentRunner,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
} from "../../ports/agent-runner.js";
import { defaultSpecStore, PLAN_DRAFT_REL_PATH } from "../../ports/core-spec-store.js";
import type { SpecStore } from "../../ports/spec-store.js";
import { plannerPrompt } from "../../prompts/plan.js";
import {
  type CoverageArtifacts,
  formatCoveragePlannerContext,
  resolveCoverageArtifacts,
  writeCoverageArtifacts,
} from "./coverage-bridge.js";
import { runPlanScouts } from "./plan-scouts.js";

/** Tool name constant (contract-owned — no tools/ import). */
export { SUBMIT_WIKI_RUN_SPEC_TOOL_NAME };

function snippet(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Resolve Spec from path-first draft only (disk).
 * Control plane is short summary + path; full Spec is never required in summary.
 */
export async function resolvePlanSpecFromAgentResult(input: {
  runWorkDir: string;
  /** Short control summary only (never the full Spec payload). */
  summary?: string;
  store?: SpecStore;
}): Promise<{ spec: WikiRunSpec; source: "draft"; draftPath: string }> {
  const store = input.store ?? defaultSpecStore;
  const fromDisk = await store.readPlanDraft(input.runWorkDir);
  if (fromDisk) {
    // Re-write normalizes / re-validates; path stays plan-draft.json.
    const draftPath = await store.writePlanDraft(input.runWorkDir, fromDisk);
    return { spec: fromDisk, source: "draft", draftPath };
  }

  const hint = input.summary?.trim()
    ? ` control summary was: ${JSON.stringify(snippet(input.summary, 160))}`
    : "";
  throw new Error(
    `Planner did not submit a complete WikiRunSpec via ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} ` +
      `(missing ${PLAN_DRAFT_REL_PATH}).${hint}`,
  );
}

export type PlanWikiSpecInput = {
  layout: RunWorkdirLayoutPaths;
  workspaceName: string;
  runtime: AgentRunner;
  wikiLanguage?: "en" | "zh";
  /** Opaque model handle — runtime adapters cast to Pi Model. */
  model?: unknown;
  /** Opaque model runtime — runtime adapters cast to Pi ModelRuntime. */
  modelRuntime?: unknown;
  /**
   * Cheaper scout model (worker). Falls back to planner model when omitted.
   */
  scoutModel?: unknown;
  scoutModelRuntime?: unknown;
  scoutMaxContextTokens?: number;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  /** Pi transport retry (workspace.limits.retry). */
  retry?: RetryLimits;
  /** Wall-clock budget for planner (and scouts via planScout path). */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  operatorNotes?: string;
  revisionFeedback?: string;
  /**
   * Sealed prior Spec for plan revise (ADR 0040 / 0036).
   * Injected into the planner prompt; synthesizer must submit a complete new Spec.
   */
  priorSpec?: WikiRunSpec;
  /** Host coverage plan override (else resolved from workdir / inventory). */
  coveragePlan?: CoveragePlan;
  /** Pre-resolved coverage artifacts (skips re-walk when handler already built). */
  coverageArtifacts?: CoverageArtifacts;
  /** Orchestration budgets (planScoutCount, planRescoutMaxRounds, …). */
  orchestration?: WorkspaceOrchestration;
  onProgress?: (attempt: NodeAttempt) => void;
  /**
   * Opaque custom tools (e.g. submit_wiki_run_spec). Injected by tool edge
   * so workflow/ never imports tools/ or Pi SDK.
   */
  customTools?: readonly unknown[];
  store?: SpecStore;
  /**
   * Attempt session.jsonl for Node details transcript (live + fixture).
   * Passed through to the synthesizer runAgent only (scouts stay private).
   */
  transcriptPath?: string;
};

export type PlanWikiSpecResult = {
  spec: WikiRunSpec;
  mode: "fixture" | "live";
  /** Short control summary only (never full Spec JSON). */
  rawSummary?: string;
  /** How the Spec was obtained. */
  source?: "draft" | "fixture";
  draftPath?: string;
  /** Scout task labels that produced receipts (empty when scouts disabled). */
  scoutKinds?: string[];
  /** Final tool/text trail from the planner agent when available. */
  items?: AttemptItem[];
  /** Best-effort projector metrics from the planner synthesizer seat. */
  metrics?: AttemptMetrics;
  /** Coverage assert result after final Spec (when plan had required units). */
  coverage?: CoverageResult;
  /** How many re-scout rounds ran after the initial scout pass. */
  rescoutRounds?: number;
};

function formatPriorSpecPrompt(prior: WikiRunSpec): string {
  const pageLines = prior.pages
    .slice(0, 40)
    .map((p) => {
      const units = [
        ...(p.coverageUnitIds ?? []),
        ...(p.sourceIds ?? []),
        ...(p.surfaceIds ?? []),
      ];
      const unitHint = units.length ? ` units=[${units.slice(0, 8).join(", ")}]` : "";
      return `- ${p.path}: ${p.purpose.slice(0, 120)}${unitHint}`;
    })
    .join("\n");
  const domainLines = prior.domains
    .slice(0, 20)
    .map((d) => `- ${d.id}: ${d.title} — ${d.scope.slice(0, 100)}`)
    .join("\n");
  return [
    "## Prior Spec (sealed — revise, do not invent a blank tree)",
    `Summary: ${prior.summary.slice(0, 500)}`,
    prior.domains.length ? `Domains:\n${domainLines}` : "Domains: (none)",
    `Pages:\n${pageLines || "(none)"}`,
    prior.changelog?.length
      ? `Prior changelog (tail):\n${prior.changelog.slice(-5).map((c) => `- ${c}`).join("\n")}`
      : "",
    "Submit a **complete** revised WikiRunSpec with changelog entry describing this revision.",
    "Preserve useful page paths and coverage bindings unless operator feedback or evidence requires change.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Plan a WikiRunSpec. Fixture runtime → default Spec; live → scouts + planner
 * with bounded re-scout on coverage gaps.
 */
export async function planWikiSpec(input: PlanWikiSpecInput): Promise<PlanWikiSpecResult> {
  const store = input.store ?? defaultSpecStore;

  if (input.runtime.kind === "fixture") {
    const spec = defaultWikiRunSpec(input.workspaceName);
    const draftPath = await store.writePlanDraft(input.layout.runWorkDir, spec);
    const items: AttemptItem[] = [
      {
        type: "text",
        text: `pages=${spec.pages.length} draft=${PLAN_DRAFT_REL_PATH}`,
      },
    ];
    const summary = "Fixture default WikiRunSpec";
    input.onProgress?.({
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      role: "plan",
      status: "done",
      summary,
      items,
    });
    // Transcript disk write is owned by pi-attempt-executor (runtime edge).
    return { spec, mode: "fixture", source: "fixture", draftPath, scoutKinds: [], items };
  }

  if (!input.model) {
    throw new Error("Live plan phase requires a model");
  }

  const orch = input.orchestration ?? { ...DEFAULT_ORCHESTRATION };

  // Coverage inventory + plan (sealed or core walk).
  const coverageArtifacts =
    input.coverageArtifacts ??
    (await resolveCoverageArtifacts({
      layout: input.layout,
      orch,
      sourceMounts: input.layout.sourceMounts,
      sourceIgnores:
        input.sourceIgnores instanceof Map
          ? input.sourceIgnores
          : undefined,
      abortSignal: input.abortSignal,
    }));
  // Prefer explicit plan override when provided.
  if (input.coveragePlan) {
    coverageArtifacts.plan = input.coveragePlan;
  }
  await writeCoverageArtifacts(input.layout, coverageArtifacts);

  const maxRescout = Math.max(0, orch.planRescoutMaxRounds ?? 0);
  let gapUnitIds: string[] | undefined;
  let lastCoverage: CoverageResult | undefined;
  let lastResolved: { spec: WikiRunSpec; source: "draft"; draftPath: string } | undefined;
  let lastChild: {
    summary?: string;
    items?: AttemptItem[];
    metrics?: AttemptMetrics;
  } | undefined;
  let allScoutLabels: string[] = [];
  let rescoutRounds = 0;

  const coverageContext = formatCoveragePlannerContext(coverageArtifacts);
  const priorBlock = input.priorSpec ? formatPriorSpecPrompt(input.priorSpec) : "";
  const revisionPrompt = input.revisionFeedback?.trim()
    ? [
        "Produce a fresh WikiRunSpec after re-reading the frozen sources.",
        `Operator feedback: ${input.revisionFeedback.trim()}`,
      ].join("\n\n")
    : "";

  const basePrompt = plannerPrompt({
    layout: input.layout,
    workspaceName: input.workspaceName,
    wikiLanguage: input.wikiLanguage,
    operatorNotes: input.operatorNotes,
    maxDomainFanOut: orch.maxDomainFanOut,
    maxLeafFanOut: orch.maxLeafFanOut,
    sourceCount: coverageArtifacts.adaptive.sourceCount,
    requiredUnitIds: coverageArtifacts.plan.requiredUnits.map((u) => u.id),
  });

  const systemPrompt = [
    "You are the Wiki planner (Spec synthesizer).",
    "Use read-only tools (ls, find, grep, read) to inspect sources/ and any plan scout receipts.",
    `Submit the complete WikiRunSpec via the ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} tool (Run Boundary writes ${PLAN_DRAFT_REL_PATH}).`,
    "Do not write wiki pages. Do not rely on chat-only JSON as the primary handoff.",
    coverageArtifacts.plan.requiredUnits.length > 0
      ? "Every required coverage unit must be bound on critical pages or cancelled via sourceCoverage/surfaceCoverage (cancelled:true + notes)."
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Fail-closed across (re)plan rounds: clear stale draft BEFORE scouts so a
  // previous round's plan-draft.json cannot be re-resolved if this round fails
  // to call submit_wiki_run_spec.
  for (let round = 0; round <= maxRescout; round++) {
    if (round > 0) rescoutRounds += 1;
    await store.clearPlanDraft(input.layout.runWorkDir);

    const scouts = await runPlanScouts({
      layout: input.layout,
      workspaceName: input.workspaceName,
      runtime: input.runtime,
      orch,
      operatorNotes: input.operatorNotes,
      model: input.scoutModel ?? input.model,
      modelRuntime: input.scoutModelRuntime ?? input.modelRuntime,
      maxContextTokens: input.scoutMaxContextTokens ?? input.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      sourceIgnores: input.sourceIgnores,
      abortSignal: input.abortSignal,
      onProgress: input.onProgress,
      runIndex: round,
      coveragePlan: coverageArtifacts.plan,
      coverageInventory: coverageArtifacts.contractInventory,
      ...(gapUnitIds ? { gapUnitIds } : {}),
    });

    allScoutLabels = scouts.tasks.map((t) =>
      t.kind === "thematic" ? t.thematic : t.kind === "source" ? `source:${t.sourceId}` : t.id,
    );

    const gapFeedback =
      gapUnitIds && gapUnitIds.length > 0
        ? [
            "## Coverage re-scout (host)",
            `Previous Spec left gaps: ${gapUnitIds.join(", ")}.`,
            "Re-read scout receipts for those units and bind them on critical pages,",
            "or cancel via sourceCoverage/surfaceCoverage with cancelled:true and notes reason",
            "(not notes/changelog alone).",
          ].join("\n")
        : "";

    const requiredScoutGapNote =
      scouts.requiredScoutGaps.length > 0
        ? [
            "## Required scout failures (coverage gaps)",
            `These unit surveys failed or returned empty: ${scouts.requiredScoutGaps.join(", ")}.`,
            "Still attempt a Spec that binds known units; do not pretend failed surveys covered them.",
          ].join("\n")
        : "";

    const child = await input.runtime.runAgent({
      role: "plan",
      spanId: round === 0 ? "plan" : `plan@${round}`,
      nodeKey: "plan",
      runIndex: round,
      runWorkDir: input.layout.runWorkDir,
      task: [
        basePrompt,
        coverageContext,
        scouts.plannerContext,
        priorBlock,
        revisionPrompt,
        gapFeedback,
        requiredScoutGapNote,
      ]
        .filter(Boolean)
        .join("\n\n"),
      systemPrompt,
      preferFinalMessage: true,
      customTools: input.customTools,
      model: input.model,
      modelRuntime: input.modelRuntime,
      sourceIgnores: input.sourceIgnores,
      maxContextTokens: input.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      retry: input.retry,
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
      onProgress: input.onProgress,
      transcriptPath: input.transcriptPath,
    });

    const resolved = await resolvePlanSpecFromAgentResult({
      runWorkDir: input.layout.runWorkDir,
      summary: child.summary,
      store,
    });

    lastChild = child;
    lastResolved = resolved;

    // Host assertCoverage after Spec submit (defense in depth with tool-time gate).
    if (coverageArtifacts.plan.requiredUnits.length === 0) {
      lastCoverage = assertCoverage(resolved.spec, coverageArtifacts.plan, {
        throwOnGap: false,
      });
      break;
    }

    const coverage = assertCoverage(resolved.spec, coverageArtifacts.plan, {
      throwOnGap: false,
    });
    lastCoverage = coverage;

    // Merge soft gaps with required scout failures that remain unbound.
    const gaps = new Set(coverage.gaps);
    for (const unitId of scouts.requiredScoutGaps) {
      // Scout failure is a gap only if still unbound after synthesize.
      if (!coverage.rows.some((r) => r.unitId === unitId && r.status === "covered")) {
        gaps.add(unitId);
      }
    }

    if (gaps.size === 0) {
      break;
    }

    if (round >= maxRescout) {
      const preview = [...gaps].slice(0, 8).join(", ");
      const more = gaps.size > 8 ? ` (+${gaps.size - 8} more)` : "";
      throw new CoverageAssertError(
        `plan coverage exhausted after ${maxRescout} re-scout round(s): ` +
          `${gaps.size} gap(s): ${preview}${more}`,
        {
          ...coverage,
          ok: false,
          stop_reason: "coverage_gap",
          gaps: [...gaps],
        },
      );
    }

    gapUnitIds = [...gaps];
  }

  if (!lastResolved) {
    throw new Error("plan phase produced no Spec");
  }

  return {
    spec: lastResolved.spec,
    mode: "live",
    rawSummary: lastChild?.summary,
    source: lastResolved.source,
    draftPath: lastResolved.draftPath,
    scoutKinds: allScoutLabels,
    ...(lastChild?.items ? { items: lastChild.items } : {}),
    ...(lastChild?.metrics ? { metrics: lastChild.metrics } : {}),
    ...(lastCoverage ? { coverage: lastCoverage } : {}),
    rescoutRounds,
  };
}
