/**
 * Shared Attempt helpers used by handlers and the thin executor.
 */

import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttemptItem,
  type PiAttemptInput,
  WikiRunSpecSchema,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import { effectiveIgnoresForSource, isPathInside } from "@okf-wiki/core";
import type { AgentRunner } from "../../ports/agent-runner.js";
import { finalizeAttemptTranscript } from "../attempt-transcript-sink.js";
import { resolveWorkspacePiModel } from "../model/provider-model.js";
import { resolveModelSelection } from "../model/role-model.js";
import type { RunWorkdirLayout } from "../workdir.js";

export type ResolvePiModel = typeof resolveWorkspacePiModel;

/** Handler bag passed from the thin executor after materialisation. */
export type AttemptHandlerContext = {
  input: PiAttemptInput;
  layout: RunWorkdirLayout;
  ignores: Map<string, readonly string[]>;
  runtime: AgentRunner;
  resolveModel: ResolvePiModel;
  signal: AbortSignal;
};

export function bounded(text: unknown): string {
  const value = String(text ?? "Pi attempt failed")
    .replace(/\s+/g, " ")
    .trim();
  return (value || "Pi attempt failed").slice(0, 4_000);
}

export function sourceIgnores(input: PiAttemptInput): Map<string, readonly string[]> {
  return new Map(
    input.workspace.sources.map((source) => [source.id, effectiveIgnoresForSource(source)]),
  );
}

/**
 * Seal a conversation-shaped attempt transcript (JSONL).
 * Prefer items/summary from the scoped agent; never metadata-only when content exists.
 * Live runs may already have written sessionPath via transcriptPath — finalize replaces
 * with a complete snapshot including optional control meta.
 */
export async function sealTranscript(
  input: PiAttemptInput,
  parts: {
    task?: string;
    items?: AttemptItem[];
    summary?: string;
    terminal?: "done" | "error" | "cancelled";
    meta?: Record<string, unknown>;
  },
): Promise<string> {
  if (!isPathInside(input.attemptDir, input.sessionPath))
    throw new Error("session path escaped attempt");
  return finalizeAttemptTranscript(input.sessionPath, {
    task: parts.task,
    items: parts.items,
    summary: parts.summary,
    terminal: parts.terminal ?? "done",
    meta: {
      node: input.node.key,
      attemptId: input.attemptId,
      ...parts.meta,
    },
  });
}

/**
 * Load WikiRunSpec: prefer projected inputs/spec.json (Phase 2 canonical),
 * then analysis/spec.json, then sealed artifact paths.
 */
export async function readSpec(
  input: PiAttemptInput,
  layout?: RunWorkdirLayout,
): Promise<WikiRunSpec> {
  const projected: string[] = [];
  if (layout) {
    projected.push(
      path.join(layout.runWorkDir, "inputs", "spec.json"),
      path.join(layout.analysisDir, "spec.json"),
    );
  } else {
    projected.push(
      path.join(input.workDir, "inputs", "spec.json"),
      path.join(input.workDir, "analysis", "spec.json"),
    );
  }
  const specInput = input.sealedInputs.find((item) => item.role === "spec");
  const sealedCandidates = specInput
    ? [
        specInput.readOnlyPath,
        path.join(specInput.readOnlyPath, "spec.json"),
        path.join(specInput.readOnlyPath, "analysis", "spec.json"),
      ]
    : [];
  const candidates = [...projected, ...sealedCandidates];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return WikiRunSpecSchema.parse(JSON.parse(await readFile(candidate, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Invalid JSON / schema: keep trying other candidates, then surface.
      if ((error as NodeJS.ErrnoException).code === undefined) {
        // zod / parse errors on a found file should fail closed for that file only if more candidates
        continue;
      }
      throw new Error(`sealed spec is unreadable: ${bounded(error)}`);
    }
  }
  if (!specInput) throw new Error("write requires a sealed spec input (role=spec)");
  throw new Error("sealed spec artifact does not contain spec.json");
}

export async function liveModel(
  input: PiAttemptInput,
  role: "planner" | "writer" | "worker" | "reviewer",
  resolveModel: ResolvePiModel,
  opts?: { seatIndex?: number },
) {
  const selected = resolveModelSelection({
    workspace: input.workspace,
    role,
    ...(opts?.seatIndex !== undefined ? { seatIndex: opts.seatIndex } : {}),
  });
  return resolveModel({ profileId: selected.profileId, modelId: selected.id });
}

/**
 * Resolve reviewer seat index from node detail or `review.seat.<lens>` key order.
 * Used for roleModels.reviewers[i] rotation.
 */
export function resolveReviewSeatIndex(input: PiAttemptInput): number {
  const detail = input.node.detail ?? {};
  if (typeof detail.seatIndex === "number" && Number.isFinite(detail.seatIndex)) {
    return Math.max(0, Math.floor(detail.seatIndex));
  }
  const match = /^review\.seat\.(.+)$/.exec(input.node.key);
  if (match?.[1]) {
    const lens = match[1];
    const order = ["grounding", "coverage", "consistency", "general"];
    const idx = order.indexOf(lens);
    if (idx >= 0) return idx;
  }
  return 0;
}

export async function readSealedWikiTree(
  input: PiAttemptInput,
  destWikiDir: string,
): Promise<void> {
  const wikiInput =
    input.sealedInputs.find((item) => item.role === "wiki_tree") ??
    input.sealedInputs.find((item) => item.role === "prior_wiki");
  if (!wikiInput) {
    throw new Error(`${input.node.kind} requires a sealed wiki_tree or prior_wiki input`);
  }
  await mkdir(path.dirname(destWikiDir), { recursive: true });
  await cp(wikiInput.readOnlyPath, destWikiDir, { recursive: true, dereference: false });
}

/**
 * Prefer sealed node.detail from WikiRuns; fall back to key conventions only
 * for missing fields so older claims without detail still run.
 */
export function parseNodeDetail(input: PiAttemptInput): Record<string, unknown> {
  const sealed = input.node.detail ?? {};
  if (input.node.kind === "research.leaf") {
    const match = /^research\.leaf\.([^.]+)\.(\d+)$/.exec(input.node.key);
    const domainId =
      (typeof sealed.domainId === "string" && sealed.domainId) || match?.[1] || "core";
    const questionIndex =
      typeof sealed.questionIndex === "number"
        ? sealed.questionIndex
        : match
          ? Number(match[2])
          : undefined;
    const question =
      (typeof sealed.question === "string" && sealed.question.trim()) ||
      (questionIndex != null ? `Question ${questionIndex}` : input.node.key);
    return {
      ...sealed,
      domainId,
      questionIndex,
      question,
      scope: typeof sealed.scope === "string" ? sealed.scope : "",
    };
  }
  if (input.node.kind === "research.domain") {
    const domainId =
      (typeof sealed.domainId === "string" && sealed.domainId) ||
      input.node.key.replace(/^research\.domain\./, "");
    const questions = Array.isArray(sealed.questions)
      ? sealed.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : [];
    return {
      ...sealed,
      domainId,
      title: (typeof sealed.title === "string" && sealed.title.trim()) || domainId,
      scope: typeof sealed.scope === "string" ? sealed.scope : "",
      questions,
    };
  }
  if (input.node.kind === "review.seat") {
    const fromKey = input.node.key.replace(/^review\.seat\./, "");
    const lens =
      (typeof sealed.lens === "string" && sealed.lens.trim()) || fromKey || "general";
    return { ...sealed, lens };
  }
  return { ...sealed };
}

/** Write a sealed/canonical JSON blob under analysis/. */
export async function writeAnalysisJson(
  layout: RunWorkdirLayout,
  fileName: string,
  value: unknown,
): Promise<string> {
  const target = path.join(layout.analysisDir, fileName);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}
