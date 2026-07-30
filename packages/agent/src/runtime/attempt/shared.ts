/**
 * Shared Attempt helpers used by handlers and the thin executor.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttemptItem,
  type PiAttemptInput,
  type WikiRunSpec,
  WikiRunSpecSchema,
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

/** Load the sealed Spec projection for this Attempt. */
export async function readSpec(layout: RunWorkdirLayout): Promise<WikiRunSpec> {
  const specPath = path.join(layout.runWorkDir, "inputs", "spec.json");
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch (error) {
    throw new Error(`projected inputs/spec.json is unreadable: ${bounded(error)}`);
  }
  try {
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`projected inputs/spec.json is invalid: ${bounded(error)}`);
  }
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

function requiredDetail(input: PiAttemptInput): NonNullable<PiAttemptInput["node"]["detail"]> {
  if (!input.node.detail) {
    throw new Error(`${input.node.kind}/${input.node.key} requires sealed node detail`);
  }
  return input.node.detail;
}

function requiredDetailString(
  input: PiAttemptInput,
  detail: NonNullable<PiAttemptInput["node"]["detail"]>,
  field: "domainId" | "question" | "scope" | "title" | "lens",
): string {
  const value = detail[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${input.node.kind}/${input.node.key} requires detail.${field}`);
  }
  return value.trim();
}

/** Resolve a sealed reviewer seat index for roleModels.reviewers[i] rotation. */
export function resolveReviewSeatIndex(input: PiAttemptInput): number {
  const detail = requiredDetail(input);
  if (typeof detail.seatIndex === "number" && Number.isFinite(detail.seatIndex)) {
    return Math.max(0, Math.floor(detail.seatIndex));
  }
  throw new Error(`${input.node.kind}/${input.node.key} requires detail.seatIndex`);
}

/** Parse the mandatory sealed detail for dynamic execution-graph nodes. */
export function parseNodeDetail(input: PiAttemptInput): Record<string, unknown> {
  const sealed = requiredDetail(input);
  if (input.node.kind === "research.leaf") {
    return {
      ...sealed,
      domainId: requiredDetailString(input, sealed, "domainId"),
      question: requiredDetailString(input, sealed, "question"),
      scope: requiredDetailString(input, sealed, "scope"),
    };
  }
  if (input.node.kind === "research.domain") {
    if (
      !Array.isArray(sealed.questions) ||
      !sealed.questions.every((question) => typeof question === "string" && question.trim())
    ) {
      throw new Error(`${input.node.kind}/${input.node.key} requires detail.questions`);
    }
    return {
      ...sealed,
      domainId: requiredDetailString(input, sealed, "domainId"),
      title: requiredDetailString(input, sealed, "title"),
      scope: requiredDetailString(input, sealed, "scope"),
      questions: sealed.questions.map((question) => question.trim()),
    };
  }
  if (input.node.kind === "review.seat") {
    return { ...sealed, lens: requiredDetailString(input, sealed, "lens") };
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
