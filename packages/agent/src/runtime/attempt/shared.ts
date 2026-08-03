/**
 * Shared Attempt helpers used by handlers and the thin executor.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type PiAttemptArtifactDescriptor, type PiAttemptFailureClass, type PiAttemptInput, type PiAttemptOutcome, PiAttemptOutcomeSchema } from "@okf-wiki/contract/pi-attempt";
import { type AttemptItem, type AttemptMetrics, type NodeAttempt, type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract/wiki-runs";
import { effectiveIgnoresForSource, isPathInside } from "@okf-wiki/core";
import type { AgentRunner } from "../../ports/agent-runner.js";
import { redactSensitiveText } from "../../redact/index.js";
import { finalizeAttemptTranscript } from "../attempt-transcript-sink.js";
import {
  type ResolvedPiModel,
  resolveWorkspacePiModel,
} from "../model/provider-model.js";
import { resolveModelSelection } from "../model/role-model.js";
import type { RunWorkdirLayout } from "../workdir.js";

export type ResolvePiModel = typeof resolveWorkspacePiModel;

/**
 * Catalog / profile model id for the resolved seat (roleModels path).
 * Prefer runtime.modelId (e.g. `openai/corp-model`) over served model.id.
 */
export function seatModelId(resolved: ResolvedPiModel | undefined): string | undefined {
  if (!resolved) return undefined;
  const catalog = resolved.runtime?.modelId?.trim();
  if (catalog) return catalog;
  const served = resolved.model?.id?.trim();
  return served || undefined;
}

/**
 * Merge live-run projector metrics with seat model + graph role.
 * Never invents token counts; missing optional fields stay absent.
 */
export function metricsFromSeatRun(input: {
  role?: string;
  modelId?: string;
  fromRun?: AttemptMetrics;
  extra?: AttemptMetrics;
}): AttemptMetrics | undefined {
  const metrics: AttemptMetrics = {
    ...(input.fromRun ?? {}),
    ...(input.extra ?? {}),
  };
  if (metrics.role === undefined && input.role) metrics.role = input.role;
  if (metrics.modelId === undefined && input.modelId) metrics.modelId = input.modelId;
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

/** Handler bag passed from the thin executor after materialisation. */
export type AttemptHandlerContext = {
  input: PiAttemptInput;
  layout: RunWorkdirLayout;
  ignores: Map<string, readonly string[]>;
  runtime: AgentRunner;
  resolveModel: ResolvePiModel;
  signal: AbortSignal;
  /** Best-effort mid-run metrics sink from WikiRuns (optional). */
  onProgress?: (metrics: AttemptMetrics) => void;
};

/**
 * Map a live scoped-runner / NodeAttempt progress span into AttemptMetrics.
 * - inputTokens ← usage.contextTokens (context-fill proxy)
 * - extra.contextWindow / contextTarget from usage when known
 * - modelId / role from seat when known
 * - toolCalls counted from items of type toolCall (optional, best-effort)
 *
 * Never invents token counts; returns undefined when nothing projectable.
 * Does not set wallTimeMs / stopReason (terminal-only fields).
 */
export function progressMetricsFromScoped(
  progress: NodeAttempt | { usage?: NodeAttempt["usage"]; items?: AttemptItem[] },
  seat?: { modelId?: string; role?: string },
): AttemptMetrics | undefined {
  const metrics: AttemptMetrics = {};
  const usage = progress.usage;
  if (usage?.contextTokens !== undefined && Number.isFinite(usage.contextTokens)) {
    metrics.inputTokens = Math.max(0, Math.floor(usage.contextTokens));
  }
  const extra: Record<string, unknown> = {};
  if (
    usage?.contextWindow !== undefined &&
    Number.isFinite(usage.contextWindow) &&
    usage.contextWindow > 0
  ) {
    extra.contextWindow = Math.floor(usage.contextWindow);
  }
  if (
    usage?.contextTarget !== undefined &&
    Number.isFinite(usage.contextTarget) &&
    usage.contextTarget > 0
  ) {
    extra.contextTarget = Math.floor(usage.contextTarget);
  }
  if (Object.keys(extra).length > 0) metrics.extra = extra;

  if (seat?.modelId?.trim()) metrics.modelId = seat.modelId.trim().slice(0, 200);
  if (seat?.role?.trim()) metrics.role = seat.role.trim().slice(0, 64);

  if (Array.isArray(progress.items)) {
    const toolCalls = progress.items.filter((item) => item.type === "toolCall").length;
    if (toolCalls > 0) metrics.toolCalls = toolCalls;
  }

  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

/** Forward scoped progress into handler onProgress (never throws). */
export function forwardScopedProgress(
  ctx: Pick<AttemptHandlerContext, "onProgress">,
  progress: NodeAttempt | { usage?: NodeAttempt["usage"]; items?: AttemptItem[] },
  seat?: { modelId?: string; role?: string },
): void {
  if (!ctx.onProgress) return;
  try {
    const metrics = progressMetricsFromScoped(progress, seat);
    if (metrics) ctx.onProgress(metrics);
  } catch {
    // Progress is best-effort; never fail the attempt.
  }
}

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
 * Uniform failed PiAttemptOutcome: redact/bound the message, seal an error
 * terminal on session.jsonl, then return a typed failed outcome.
 *
 * Prefer this over bare `{ type: "failed" }` returns that skip transcripts.
 * Throw paths still go through the executor catch (which finalizes similarly).
 */
export async function failAttempt(
  input: PiAttemptInput,
  parts: {
    error: unknown;
    failureClass: PiAttemptFailureClass;
    unsealedArtifacts?: PiAttemptArtifactDescriptor[];
    task?: string;
    items?: AttemptItem[];
    meta?: Record<string, unknown>;
  },
): Promise<PiAttemptOutcome> {
  const message = bounded(
    redactSensitiveText(
      parts.error instanceof Error ? parts.error.message : String(parts.error ?? "Pi attempt failed"),
    ),
  );
  const transcript = await sealTranscript(input, {
    task: parts.task,
    items: parts.items,
    summary: message,
    terminal: parts.failureClass === "cancelled" ? "cancelled" : "error",
    meta: {
      mode: "failed",
      failureClass: parts.failureClass,
      error: message,
      ...parts.meta,
    },
  });
  const unsealedArtifacts: PiAttemptArtifactDescriptor[] = [
    ...(parts.unsealedArtifacts ?? []),
    { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
  ];
  return PiAttemptOutcomeSchema.parse({
    type: "failed",
    error: message,
    failureClass: parts.failureClass,
    unsealedArtifacts,
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
