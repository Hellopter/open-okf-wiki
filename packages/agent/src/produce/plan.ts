/**
 * Planner: living WikiRunSpec via ProduceRuntime (or default Spec for fixture).
 * Path-first handoff: prefer analysis/plan-draft.json from submit_wiki_run_spec;
 * fail-closed JSON parse only as Host spill fallback — no invented thin plans.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  defaultWikiRunSpec,
  type WikiProduceChildSpan,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { PLAN_DRAFT_REL_PATH, readPlanDraft, writePlanDraft } from "./living-spec.js";
import type { ProduceRuntime } from "./produce-runtime.js";
import { plannerPrompt } from "./prompts.js";
import { SUBMIT_WIKI_RUN_SPEC_TOOL_NAME } from "./submit-wiki-run-spec-tool.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompleteSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = [
    "version",
    "summary",
    "audience",
    "domains",
    "pages",
    "openQuestions",
    "acceptance",
    "changelog",
  ];
  if (!required.every((key) => key in value)) return false;
  if (!Array.isArray(value.domains) || !Array.isArray(value.pages)) return false;
  if (
    !value.domains.every(
      (domain) =>
        isRecord(domain) &&
        ["id", "title", "scope", "critical", "questions"].every((key) => key in domain),
    )
  ) {
    return false;
  }
  if (
    !value.pages.every(
      (page) =>
        isRecord(page) &&
        ["path", "purpose", "domainIds", "questions", "critical"].every((key) => key in page),
    )
  ) {
    return false;
  }
  const acceptance = value.acceptance;
  return (
    isRecord(acceptance) &&
    ["reviewRequired", "maxRepairRounds", "blockingSeverities"].every((key) => key in acceptance)
  );
}

function snippet(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function parsePlanFromAgentText(text: string): WikiRunSpec {
  const raw = text?.trim() ?? "";
  // Prefer the last fenced JSON block (models often narrate then fence the Spec).
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]?.trim() ?? "");
  const candidates = [...fences.reverse(), raw].filter(
    (candidate, index, values): candidate is string =>
      Boolean(candidate) && values.indexOf(candidate) === index,
  );

  for (const candidate of candidates) {
    try {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (!isCompleteSpec(value)) continue;
      const parsed = WikiRunSpecSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch {
      // next candidate
    }
  }

  throw new Error(
    `Planner did not return a complete JSON WikiRunSpec (len=${raw.length}, head=${JSON.stringify(snippet(raw))})`,
  );
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
  onProgress?: (span: WikiProduceChildSpan) => void;
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
      id: "plan",
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

  const child = await input.runtime.runAgent({
    role: "plan",
    spanId: "plan",
    runWorkDir: input.layout.runWorkDir,
    task: [basePrompt, revisionPrompt].filter(Boolean).join("\n\n"),
    systemPrompt: [
      "You are the Wiki planner.",
      "Use read-only tools (ls, find, grep, read) to inspect sources/.",
      `Submit the complete WikiRunSpec via the ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} tool (Host writes ${PLAN_DRAFT_REL_PATH}).`,
      "Do not write wiki pages. Do not rely on chat-only JSON as the primary handoff.",
    ].join(" "),
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
