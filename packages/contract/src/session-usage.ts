/**
 * Ephemeral Operator Session context-fill projection (UI only).
 *
 * `contextTokens` is a last-assistant `usage.totalTokens` proxy — not a durable
 * WikiRuns control fact and not a billing meter (ADR 0035: no token-delta as
 * control truth; no provider $ display).
 */

import { z } from "zod";
import { isRecord } from "./agent-message.js";

/** Optional session context fill for Operator chrome. */
export const SessionUsageSchema = z
  .object({
    /** Last assistant totalTokens as fill proxy (when known). */
    contextTokens: z.number().nonnegative().optional(),
    /** Provider / product hard window. */
    contextWindow: z.number().positive().optional(),
    /** Operational compaction target (may be below window). */
    contextTarget: z.number().positive().optional(),
  })
  .strict();

export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/**
 * Walk Pi history rows newest-first and return the last assistant
 * `usage.totalTokens` when present and finite.
 */
export function extractContextTokensFromPiHistory(
  rows: readonly unknown[],
): number | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!isRecord(row) || row.role !== "assistant") continue;
    if (!isRecord(row.usage)) continue;
    const total = row.usage.totalTokens;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
      return total;
    }
  }
  return undefined;
}

/**
 * Extract totalTokens from a single Pi message_end / assistant message body.
 * Returns undefined when usage is absent.
 */
export function extractContextTokensFromPiMessage(message: unknown): number | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  if (!isRecord(message.usage)) return undefined;
  const total = message.usage.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
    return total;
  }
  return undefined;
}

/**
 * Build a sessionUsage object only when at least one field is present.
 * Returns undefined for empty/noise (UI should hide the chip).
 */
export function buildSessionUsage(input: {
  contextTokens?: number;
  contextWindow?: number;
  contextTarget?: number;
}): SessionUsage | undefined {
  const out: SessionUsage = {};
  if (
    typeof input.contextTokens === "number" &&
    Number.isFinite(input.contextTokens) &&
    input.contextTokens >= 0
  ) {
    out.contextTokens = input.contextTokens;
  }
  if (
    typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
  ) {
    out.contextWindow = Math.floor(input.contextWindow);
  }
  if (
    typeof input.contextTarget === "number" &&
    Number.isFinite(input.contextTarget) &&
    input.contextTarget > 0
  ) {
    out.contextTarget = Math.floor(input.contextTarget);
  }
  if (
    out.contextTokens === undefined &&
    out.contextWindow === undefined &&
    out.contextTarget === undefined
  ) {
    return undefined;
  }
  return out;
}

/** Compact token count for chrome (`1.2k`, `3.4M`). */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    // One decimal under 100k so "12.4k" reads clearly; whole k above.
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(tokens));
}

/**
 * Fill percent against window (preferred) or target.
 * null when tokens or denominator missing.
 */
export function contextFillPercent(usage: SessionUsage): number | null {
  const tokens = usage.contextTokens;
  const denom = usage.contextWindow ?? usage.contextTarget;
  if (
    typeof tokens !== "number" ||
    typeof denom !== "number" ||
    !Number.isFinite(tokens) ||
    !Number.isFinite(denom) ||
    denom <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, (tokens / denom) * 100));
}

export type ContextFillView = {
  /** e.g. `12.4k / 128k` — never `0 / 0`. */
  label: string;
  /** 0–100 when both sides known; otherwise null. */
  percent: number | null;
  /** Which denominator the label uses. */
  denomKind: "window" | "target" | "tokens_only";
};

/**
 * Format context fill for Operator chrome.
 * Returns null when there is nothing useful to show (hide the chip).
 *
 * Requires known `contextTokens` (last assistant usage). Window/target alone
 * is not enough — empty sessions must not paint `? / 128k` noise.
 */
export function formatContextFill(usage: SessionUsage | null | undefined): ContextFillView | null {
  if (!usage) return null;
  const tokens = usage.contextTokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
    return null;
  }
  const window = usage.contextWindow;
  const target = usage.contextTarget;
  const denom =
    typeof window === "number" && window > 0
      ? window
      : typeof target === "number" && target > 0
        ? target
        : undefined;
  const denomKind: ContextFillView["denomKind"] =
    typeof window === "number" && window > 0
      ? "window"
      : typeof target === "number" && target > 0
        ? "target"
        : "tokens_only";

  if (typeof denom === "number") {
    return {
      label: `${formatTokenCount(tokens)} / ${formatTokenCount(denom)}`,
      percent: contextFillPercent({ ...usage, contextWindow: denom }),
      denomKind,
    };
  }
  // Tokens without a known window — still useful as a size hint.
  if (tokens === 0) return null;
  return {
    label: formatTokenCount(tokens),
    percent: null,
    denomKind: "tokens_only",
  };
}
