/**
 * Attempt observation metrics: graph role defaults, SQLite persist, snapshot projection.
 * Phase 0 baseline — missing optional fields never block attempt completion.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  type AttemptMetrics,
  AttemptMetricsSchema,
  type WikiRunNodeKind,
} from "@okf-wiki/contract";
import { asRow, requiredText } from "./sql.js";

/** Map durable node kind → short graph role for metrics / cost attribution. */
export function graphRoleForNodeKind(kind: string): string {
  switch (kind as WikiRunNodeKind | string) {
    case "plan":
      return "plan";
    case "research.leaf":
      return "leaf";
    case "research.domain":
      return "domain";
    case "write.root":
      return "writer";
    case "review.seat":
      return "review";
    case "repair":
      return "repair";
    case "freeze":
    case "validate.pre":
    case "validate.final":
    case "review.reduce":
    case "prepare.publication":
    case "publish":
    case "gate.plan":
    case "gate.fix":
    case "gate.publication":
      return "mechanical";
    default:
      if (kind.startsWith("research.leaf")) return "leaf";
      if (kind.startsWith("research.domain")) return "domain";
      if (kind.startsWith("review.seat")) return "review";
      if (kind.startsWith("repair")) return "repair";
      if (kind.startsWith("gate.")) return "mechanical";
      return kind.slice(0, 64) || "unknown";
  }
}

/** Wall-clock ms from attempt started_at to an ISO ended timestamp. */
export function wallTimeMsFromStarted(
  db: DatabaseSync,
  attemptId: string,
  endedAt: string,
): number | undefined {
  const row = asRow(
    db.prepare("SELECT started_at FROM attempts WHERE attempt_id = ?").get(attemptId),
  );
  if (!row) return undefined;
  const startedAt = requiredText(row, "started_at");
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.min(Math.floor(end - start), 2_147_483_647);
}

/** Normalize partial metrics; drop empty objects. Never throws on bad input. */
export function normalizeAttemptMetrics(value: unknown): AttemptMetrics | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = AttemptMetricsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}

/**
 * Merge executor-supplied metrics with control-plane defaults (role, wall time, stop).
 * Control-plane values fill gaps only — executor wins when present.
 */
export function mergeAttemptMetrics(
  provided: AttemptMetrics | undefined,
  defaults: {
    role?: string;
    wallTimeMs?: number;
    stopReason?: string;
    modelId?: string;
  },
): AttemptMetrics | undefined {
  const merged: AttemptMetrics = { ...(provided ?? {}) };
  if (merged.role === undefined && defaults.role) merged.role = defaults.role;
  if (merged.wallTimeMs === undefined && defaults.wallTimeMs !== undefined) {
    merged.wallTimeMs = defaults.wallTimeMs;
  }
  if (merged.stopReason === undefined && defaults.stopReason) {
    merged.stopReason = defaults.stopReason;
  }
  if (merged.modelId === undefined && defaults.modelId) {
    merged.modelId = defaults.modelId;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Persist metrics columns on a terminal attempt row.
 * Safe to call with undefined (no-op). Does not change attempt state.
 */
export function writeAttemptMetrics(
  db: DatabaseSync,
  attemptId: string,
  metrics: AttemptMetrics | undefined,
): void {
  if (!metrics) return;
  const extraJson =
    metrics.extra && Object.keys(metrics.extra).length > 0 ? JSON.stringify(metrics.extra) : null;
  db.prepare(
    `UPDATE attempts SET
       role = COALESCE(?, role),
       model_id = COALESCE(?, model_id),
       input_tokens = COALESCE(?, input_tokens),
       output_tokens = COALESCE(?, output_tokens),
       cache_tokens = COALESCE(?, cache_tokens),
       cost_estimate = COALESCE(?, cost_estimate),
       tool_calls = COALESCE(?, tool_calls),
       wall_time_ms = COALESCE(?, wall_time_ms),
       projection_bytes = COALESCE(?, projection_bytes),
       stop_reason = COALESCE(?, stop_reason),
       metrics_json = COALESCE(?, metrics_json)
     WHERE attempt_id = ?`,
  ).run(
    metrics.role ?? null,
    metrics.modelId ?? null,
    metrics.inputTokens ?? null,
    metrics.outputTokens ?? null,
    metrics.cacheTokens ?? null,
    metrics.costEstimate ?? null,
    metrics.toolCalls ?? null,
    metrics.wallTimeMs ?? null,
    metrics.projectionBytes ?? null,
    metrics.stopReason ?? null,
    extraJson,
    attemptId,
  );
}

/** Project SQLite attempt row columns into AttemptMetrics (undefined when empty). */
export function projectAttemptMetrics(row: Record<string, unknown>): AttemptMetrics | undefined {
  const out: AttemptMetrics = {};
  if (typeof row.role === "string" && row.role.trim()) out.role = row.role.trim().slice(0, 64);
  if (typeof row.model_id === "string" && row.model_id.trim()) {
    out.modelId = row.model_id.trim().slice(0, 200);
  }
  if (
    typeof row.input_tokens === "number" &&
    Number.isFinite(row.input_tokens) &&
    row.input_tokens >= 0
  ) {
    out.inputTokens = Math.floor(row.input_tokens);
  }
  if (
    typeof row.output_tokens === "number" &&
    Number.isFinite(row.output_tokens) &&
    row.output_tokens >= 0
  ) {
    out.outputTokens = Math.floor(row.output_tokens);
  }
  if (
    typeof row.cache_tokens === "number" &&
    Number.isFinite(row.cache_tokens) &&
    row.cache_tokens >= 0
  ) {
    out.cacheTokens = Math.floor(row.cache_tokens);
  }
  if (
    typeof row.cost_estimate === "number" &&
    Number.isFinite(row.cost_estimate) &&
    row.cost_estimate >= 0
  ) {
    out.costEstimate = row.cost_estimate;
  }
  if (
    typeof row.tool_calls === "number" &&
    Number.isFinite(row.tool_calls) &&
    row.tool_calls >= 0
  ) {
    out.toolCalls = Math.floor(row.tool_calls);
  }
  if (
    typeof row.wall_time_ms === "number" &&
    Number.isFinite(row.wall_time_ms) &&
    row.wall_time_ms >= 0
  ) {
    out.wallTimeMs = Math.floor(row.wall_time_ms);
  }
  if (
    typeof row.projection_bytes === "number" &&
    Number.isFinite(row.projection_bytes) &&
    row.projection_bytes >= 0
  ) {
    out.projectionBytes = Math.floor(row.projection_bytes);
  }
  if (typeof row.stop_reason === "string" && row.stop_reason.trim()) {
    out.stopReason = row.stop_reason.trim().slice(0, 128);
  }
  if (typeof row.metrics_json === "string" && row.metrics_json.trim()) {
    try {
      const parsed = JSON.parse(row.metrics_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.extra = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore corrupt metrics_json
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Pull AttemptMetrics off a failed Error / outcome-shaped object. */
export function metricsOf(error: unknown): AttemptMetrics | undefined {
  if (!error || typeof error !== "object" || !("metrics" in error)) return undefined;
  return normalizeAttemptMetrics((error as { metrics?: unknown }).metrics);
}
