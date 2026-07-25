/**
 * Planner: living WikiRunSpec via ProduceRuntime (or default Spec for fixture).
 * Path-first handoff: prefer analysis/plan-draft.json from submit_wiki_run_spec;
 * fail-closed when draft is missing — no invented thin plans / chat JSON spill.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  defaultWikiRunSpec,
  type NodeAttempt,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { PLAN_DRAFT_REL_PATH, readPlanDraft, writePlanDraft } from "./living-spec.js";
import type { ProduceRuntime } from "./produce-runtime.js";
import { plannerPrompt } from "./prompts.js";
import {
  createSubmitWikiRunSpecTool,
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
} from "./submit-wiki-run-spec-tool.js";

function snippet(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Resolve Spec from path-first draft only.
 * Control plane is short summary + path; full Spec is never required in summary.
 */
export async function resolvePlanSpecFromAgentResult(input: {
  runWorkDir: string;
  /** Relative path from submit tool (e.g. analysis/plan-draft.json). */
  specPath?: string;
  /** Short control summary only (never the full Spec payload). */
  summary?: string;
}): Promise<{ spec: WikiRunSpec; source: "draft"; draftPath: string }> {
  if (input.specPath && input.specPath !== PLAN_DRAFT_REL_PATH) {
    throw new Error(
      `Planner submitted unexpected path ${input.specPath}; expected ${PLAN_DRAFT_REL_PATH}`,
    );
  }

  const fromDisk = await readPlanDraft(input.runWorkDir);
  if (fromDisk) {
    // Re-write normalizes / re-validates; path stays plan-draft.json.
    const draftPath = await writePlanDraft(input.runWorkDir, fromDisk);
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
  layout: RunWorkdirLayout;
  workspaceName: string;
  runtime: ProduceRuntime;
  wikiLanguage?: "en" | "zh";
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  abortSignal?: AbortSignal;
  operatorNotes?: string;
  priorSpec?: WikiRunSpec;
  revisionFeedback?: string;
  onProgress?: (attempt: NodeAttempt) => void;
};

export type PlanWikiSpecResult = {
  spec: WikiRunSpec;
  mode: "fixture" | "live";
  /** Short control summary only (never full Spec JSON). */
  rawSummary?: string;
  /** How the Spec was obtained. */
  source?: "draft" | "fixture";
  draftPath?: string;
};

/**
 * Plan a WikiRunSpec. Fixture runtime → default Spec; live → planner agent + path-first resolve.
 * Does not commit Spec to living analysis/spec.json — caller (runWiki) owns commitSpec.
 */
export async function planWikiSpec(input: PlanWikiSpecInput): Promise<PlanWikiSpecResult> {
  if (input.runtime.kind === "fixture") {
    const spec = input.priorSpec ?? defaultWikiRunSpec(input.workspaceName);
    const draftPath = await writePlanDraft(input.layout.runWorkDir, spec);
    input.onProgress?.({
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      role: "plan",
      status: "done",
      summary: "Fixture default WikiRunSpec",
      items: [{ type: "text", text: `pages=${spec.pages.length} draft=${PLAN_DRAFT_REL_PATH}` }],
    });
    return { spec, mode: "fixture", source: "fixture", draftPath };
  }

  if (!input.model) {
    throw new Error("Live plan phase requires a model");
  }

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
    "You are the Wiki planner.",
    "Use read-only tools (ls, find, grep, read) to inspect sources/.",
    `Submit the complete WikiRunSpec via the ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} tool (Run Boundary writes ${PLAN_DRAFT_REL_PATH}).`,
    "Do not write wiki pages. Do not rely on chat-only JSON as the primary handoff.",
  ].join(" ");

  const child = await input.runtime.runAgent({
    role: "plan",
    spanId: "plan",
    runWorkDir: input.layout.runWorkDir,
    task: [basePrompt, revisionPrompt].filter(Boolean).join("\n\n"),
    systemPrompt,
    // Official Pi customTools slot — runner no longer injects by role.
    customTools: [createSubmitWikiRunSpecTool({ runWorkDir: input.layout.runWorkDir })],
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
    specPath: child.specPath,
    summary: child.summary,
  });

  return {
    spec: resolved.spec,
    mode: "live",
    rawSummary: child.summary,
    source: resolved.source,
    draftPath: resolved.draftPath,
  };
}
