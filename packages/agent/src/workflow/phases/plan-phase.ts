/**
 * Planner: living WikiRunSpec via AgentRunner (or default Spec for fixture).
 * Path-first handoff: prefer analysis/plan-draft.json from submit_wiki_run_spec;
 * fail-closed when draft is missing — no invented thin plans / chat JSON spill.
 *
 * Optional plan scouts (orchestration.planScoutCount) run first as MoA proposers;
 * only this synthesizer may submit the Spec.
 *
 * Workflow stays free of Pi SDK and tools/: live callers inject customTools
 * (submit_wiki_run_spec) via PlanWikiSpecInput.customTools.
 */

import {
  defaultWikiRunSpec,
  type NodeAttempt,
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
import { DEFAULT_ORCHESTRATION } from "../budgets.js";
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
  abortSignal?: AbortSignal;
  operatorNotes?: string;
  priorSpec?: WikiRunSpec;
  revisionFeedback?: string;
  /** Orchestration budgets (planScoutCount, …). */
  orchestration?: WorkspaceOrchestration;
  onProgress?: (attempt: NodeAttempt) => void;
  /**
   * Opaque custom tools (e.g. submit_wiki_run_spec). Injected by tool edge
   * so workflow/ never imports tools/ or Pi SDK.
   */
  customTools?: readonly unknown[];
  store?: SpecStore;
};

export type PlanWikiSpecResult = {
  spec: WikiRunSpec;
  mode: "fixture" | "live";
  /** Short control summary only (never full Spec JSON). */
  rawSummary?: string;
  /** How the Spec was obtained. */
  source?: "draft" | "fixture";
  draftPath?: string;
  /** Scout kinds that produced receipts (empty when scouts disabled). */
  scoutKinds?: string[];
};

/**
 * Plan a WikiRunSpec. Fixture runtime → default Spec; live → optional scouts + planner.
 * Does not commit Spec to living analysis/spec.json — caller owns commitSpec.
 */
export async function planWikiSpec(input: PlanWikiSpecInput): Promise<PlanWikiSpecResult> {
  const store = input.store ?? defaultSpecStore;

  if (input.runtime.kind === "fixture") {
    const spec = input.priorSpec ?? defaultWikiRunSpec(input.workspaceName);
    const draftPath = await store.writePlanDraft(input.layout.runWorkDir, spec);
    input.onProgress?.({
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      role: "plan",
      status: "done",
      summary: "Fixture default WikiRunSpec",
      items: [{ type: "text", text: `pages=${spec.pages.length} draft=${PLAN_DRAFT_REL_PATH}` }],
    });
    return { spec, mode: "fixture", source: "fixture", draftPath, scoutKinds: [] };
  }

  if (!input.model) {
    throw new Error("Live plan phase requires a model");
  }

  const orch = input.orchestration ?? { ...DEFAULT_ORCHESTRATION };

  // Fail-closed across (re)plan rounds: clear stale draft BEFORE scouts so a
  // previous round's plan-draft.json cannot be re-resolved if this round fails
  // to call submit_wiki_run_spec.
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
    runIndex: 0,
  });

  const basePrompt = plannerPrompt({
    layout: input.layout,
    workspaceName: input.workspaceName,
    wikiLanguage: input.wikiLanguage,
    operatorNotes: input.operatorNotes,
  });
  const revisionPrompt = input.priorSpec
    ? [
        "Revise the existing WikiRunSpec after re-reading the frozen sources.",
        `Operator feedback: ${input.revisionFeedback?.trim() || "Re-evaluate the Spec."}`,
        "Existing WikiRunSpec:",
        JSON.stringify(input.priorSpec),
      ].join("\n\n")
    : "";

  const systemPrompt = [
    "You are the Wiki planner (Spec synthesizer).",
    "Use read-only tools (ls, find, grep, read) to inspect sources/ and any plan scout receipts.",
    `Submit the complete WikiRunSpec via the ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} tool (Run Boundary writes ${PLAN_DRAFT_REL_PATH}).`,
    "Do not write wiki pages. Do not rely on chat-only JSON as the primary handoff.",
  ].join(" ");

  const child = await input.runtime.runAgent({
    role: "plan",
    spanId: "plan",
    nodeKey: "plan",
    runIndex: 0,
    runWorkDir: input.layout.runWorkDir,
    task: [basePrompt, scouts.plannerContext, revisionPrompt].filter(Boolean).join("\n\n"),
    systemPrompt,
    preferFinalMessage: true,
    // Official Pi customTools slot — injected by tool edge (no tools/ import here).
    customTools: input.customTools,
    model: input.model,
    modelRuntime: input.modelRuntime,
    sourceIgnores: input.sourceIgnores,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    abortSignal: input.abortSignal,
    onProgress: input.onProgress,
  });

  const resolved = await resolvePlanSpecFromAgentResult({
    runWorkDir: input.layout.runWorkDir,
    summary: child.summary,
    store,
  });

  return {
    spec: resolved.spec,
    mode: "live",
    rawSummary: child.summary,
    source: resolved.source,
    draftPath: resolved.draftPath,
    scoutKinds: scouts.receipts.map((r) => r.kind),
  };
}
