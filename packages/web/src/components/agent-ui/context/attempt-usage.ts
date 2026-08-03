/**
 * Map WikiRunAttempt metrics (+ optional NodeAttempt-like usage) into SessionUsage
 * for context-fill chrome. Pure helpers — no React.
 *
 * Fill proxy: metrics.inputTokens (last totalTokens) ?? usage.contextTokens.
 * Denominator: usage.contextWindow / usage.contextTarget when known (tokens_only otherwise).
 * Never surfaces cost.
 */

import {
  buildSessionUsage,
  deriveContextPhase,
  formatContextFill,
  formatTokenCount,
  type SessionUsage,
} from "@okf-wiki/contract/session";
import type { AttemptMetrics, WikiRunAttempt } from "@okf-wiki/contract/wiki-runs";

/** Optional NodeAttempt.usage-shaped fields (live progress / contract run-graph). */
export type AttemptUsageFields = {
  contextTokens?: number;
  contextWindow?: number;
  contextTarget?: number;
};

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** Pull window/target from metrics.extra when present (additive observation fields). */
export function usageFieldsFromMetricsExtra(
  metrics: AttemptMetrics | null | undefined,
): AttemptUsageFields | undefined {
  const extra = metrics?.extra;
  if (!extra || typeof extra !== "object") return undefined;
  const contextWindow = positiveInt(extra.contextWindow);
  const contextTarget = positiveInt(extra.contextTarget);
  const contextTokens = nonNegInt(extra.contextTokens);
  if (
    contextWindow === undefined &&
    contextTarget === undefined &&
    contextTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextTarget !== undefined ? { contextTarget } : {}),
  };
}

/**
 * Build SessionUsage for the context meter from an attempt + optional live usage.
 * Prefer metrics.inputTokens as fill proxy; fall back to usage.contextTokens.
 */
export function sessionUsageFromAttempt(
  attempt: Pick<WikiRunAttempt, "metrics"> | { metrics?: AttemptMetrics | null } | null | undefined,
  usage?: AttemptUsageFields | null,
): SessionUsage | undefined {
  if (!attempt && !usage) return undefined;
  const metrics = attempt?.metrics ?? undefined;
  const fromExtra = usageFieldsFromMetricsExtra(metrics);
  const contextTokens =
    nonNegInt(metrics?.inputTokens) ??
    nonNegInt(usage?.contextTokens) ??
    nonNegInt(fromExtra?.contextTokens);
  const contextWindow = positiveInt(usage?.contextWindow) ?? fromExtra?.contextWindow;
  const contextTarget = positiveInt(usage?.contextTarget) ?? fromExtra?.contextTarget;
  return buildSessionUsage({
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextTarget !== undefined ? { contextTarget } : {}),
  });
}

/** Derive phase for attempt chrome (no compacting stream flag on historical attempts). */
export function contextPhaseFromAttemptUsage(
  usage: SessionUsage | null | undefined,
): ReturnType<typeof deriveContextPhase> {
  if (!usage) return "unknown";
  return deriveContextPhase({
    contextTokens: usage.contextTokens,
    contextWindow: usage.contextWindow,
    contextTarget: usage.contextTarget,
  });
}

export type AttemptTokenSideNote = {
  /** e.g. `in 12.4k · out 1.2k · tools 3` */
  label: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
};

/**
 * Compact side note for in/out/tools when any field is present.
 * Labels are pre-formatted fragments (`in 12.4k`) supplied by the caller/i18n.
 */
export function formatAttemptTokenSideNote(
  metrics: AttemptMetrics | null | undefined,
  formatters: {
    in: (n: string) => string;
    out: (n: string) => string;
    tools: (n: string) => string;
  },
): AttemptTokenSideNote | null {
  if (!metrics) return null;
  const parts: string[] = [];
  const inputTokens = nonNegInt(metrics.inputTokens);
  const outputTokens = nonNegInt(metrics.outputTokens);
  const toolCalls = nonNegInt(metrics.toolCalls);
  if (inputTokens !== undefined) parts.push(formatters.in(formatTokenCount(inputTokens)));
  if (outputTokens !== undefined) parts.push(formatters.out(formatTokenCount(outputTokens)));
  if (toolCalls !== undefined) parts.push(formatters.tools(String(toolCalls)));
  if (parts.length === 0) return null;
  return {
    label: parts.join(" · "),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

/** Capacity failure class or message patterns (display hint only). */
const CAPACITY_MESSAGE =
  /context overflow|context.?length|maximum context|prompt is too long|context_length|too many tokens|token limit exceeded|input is too long|compact-and-retry|exceeds capacity gate|\bcapacity\b/i;

export function isCapacityFailure(
  failureClass: string | null | undefined,
  error: string | null | undefined,
): boolean {
  if (failureClass === "capacity") return true;
  if (typeof error === "string" && error.length > 0 && CAPACITY_MESSAGE.test(error)) {
    return true;
  }
  return false;
}

/** Latest attempt for a node (highest generation / runIndex). */
export function latestAttemptOnNode(
  attempts: readonly WikiRunAttempt[],
  nodeKey: string,
): WikiRunAttempt | null {
  let best: WikiRunAttempt | null = null;
  for (const attempt of attempts) {
    if (attempt.nodeKey !== nodeKey) continue;
    if (!best) {
      best = attempt;
      continue;
    }
    if (
      attempt.nodeGeneration > best.nodeGeneration ||
      (attempt.nodeGeneration === best.nodeGeneration && attempt.runIndex > best.runIndex)
    ) {
      best = attempt;
    }
  }
  return best;
}

export type NodeContextFillSummary = {
  usage: SessionUsage;
  percent: number | null;
  fillLabel: string;
  modelId?: string;
  sideNote?: string;
  phase: ReturnType<typeof deriveContextPhase>;
};

/**
 * Graph hover / micro-dot summary for a node's latest attempt.
 * Returns null when there is nothing useful to show.
 */
export function nodeContextFillSummary(
  attempts: readonly WikiRunAttempt[],
  nodeKey: string,
  formatters?: {
    in: (n: string) => string;
    out: (n: string) => string;
    tools: (n: string) => string;
  },
): NodeContextFillSummary | null {
  const attempt = latestAttemptOnNode(attempts, nodeKey);
  if (!attempt) return null;
  const usage = sessionUsageFromAttempt(attempt);
  const view = formatContextFill(usage);
  const side = formatters
    ? formatAttemptTokenSideNote(attempt.metrics, formatters)
    : null;
  if (!view && !attempt.metrics?.modelId && !side) return null;
  const phase = contextPhaseFromAttemptUsage(usage);
  return {
    usage: usage ?? {},
    percent: view?.percent ?? null,
    fillLabel: view?.label ?? "",
    ...(attempt.metrics?.modelId ? { modelId: attempt.metrics.modelId } : {}),
    ...(side ? { sideNote: side.label } : {}),
    phase,
  };
}

/** Build a single-line hover title for a graph node. */
export function formatNodeContextHoverTitle(
  baseLabel: string,
  summary: NodeContextFillSummary | null,
): string {
  if (!summary) return baseLabel;
  const parts = [baseLabel];
  if (summary.modelId) parts.push(summary.modelId);
  if (summary.fillLabel) parts.push(summary.fillLabel);
  if (summary.sideNote) parts.push(summary.sideNote);
  return parts.join(" · ");
}

export type StageNodeRef = {
  key: string;
  state: string;
};

/**
 * Overview stage micro-dot: one summary across stage nodes.
 * Prefer a running node that has fill; otherwise the node with the highest fill percent.
 */
export function stageContextFillSummary(
  attempts: readonly WikiRunAttempt[],
  stageNodes: readonly StageNodeRef[],
  formatters?: {
    in: (n: string) => string;
    out: (n: string) => string;
    tools: (n: string) => string;
  },
): NodeContextFillSummary | null {
  let best: {
    summary: NodeContextFillSummary;
    running: boolean;
    percent: number;
  } | null = null;

  for (const node of stageNodes) {
    const summary = nodeContextFillSummary(attempts, node.key, formatters);
    if (!summary) continue;
    // Only surface when there is a real fill view (percent or label).
    if (summary.percent == null && !summary.fillLabel) continue;
    const running = node.state === "running";
    const percent = summary.percent ?? -1;
    if (!best) {
      best = { summary, running, percent };
      continue;
    }
    if (running && !best.running) {
      best = { summary, running, percent };
      continue;
    }
    if (running === best.running && percent > best.percent) {
      best = { summary, running, percent };
    }
  }

  return best?.summary ?? null;
}
