/**
 * Run Graph — observation model for one Wiki Run (not an execution engine).
 *
 * Shape authority for topology + append-only attempts. Live projection rides
 * wiki_produce tool details; durable copy lives under the Run Boundary.
 */

import { z } from "zod";

/** Bounded display item from an in-process scoped session (not Operator Session history). */
export const AttemptItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().max(8000),
  }),
  z.object({
    type: z.literal("toolCall"),
    name: z.string().trim().min(1).max(120),
    argsSummary: z.string().max(500).optional(),
    status: z.enum(["running", "done", "error"]).optional(),
  }),
]);

export type AttemptItem = z.infer<typeof AttemptItemSchema>;

export const GraphNodeKindSchema = z.enum([
  "plan",
  "domain",
  "leaf",
  "write",
  "review",
  "repair",
  "validate",
  "publish",
]);

export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;

export const GraphNodeDefSchema = z.object({
  nodeKey: z.string().trim().min(1).max(200),
  kind: GraphNodeKindSchema,
  label: z.string().trim().min(1).max(200),
  parentKey: z.string().trim().min(1).max(200).optional(),
  dependsOn: z.array(z.string().trim().min(1).max(200)).max(32).optional(),
});

export type GraphNodeDef = z.infer<typeof GraphNodeDefSchema>;

export const NodeAttemptStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "error",
  "cancelled",
  "skipped",
  "awaiting",
]);

export type NodeAttemptStatus = z.infer<typeof NodeAttemptStatusSchema>;

export const ErrorClassSchema = z.enum([
  "transient",
  "schema",
  "quality",
  "policy",
  "budget",
  "needs_input",
]);

export type ErrorClass = z.infer<typeof ErrorClassSchema>;

/** Semantic role that executed one attempt (scoped agent loop). */
export const AttemptRoleSchema = z.enum([
  "plan",
  "domain",
  "leaf",
  "reviewer",
  "root_research",
  "root_write",
  "repair",
  "validate",
  "publish",
]);

export type AttemptRole = z.infer<typeof AttemptRoleSchema>;

/**
 * One execution of a topology node. Append-only: never overwrite prior attempts
 * for the same nodeKey when runIndex advances (review/repair rounds, retries).
 */
export const NodeAttemptSchema = z.object({
  attemptId: z.string().trim().min(1).max(200),
  nodeKey: z.string().trim().min(1).max(200),
  runIndex: z.number().int().nonnegative(),
  role: AttemptRoleSchema.optional(),
  status: NodeAttemptStatusSchema,
  errorClass: ErrorClassSchema.optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  endedAt: z.string().datetime({ offset: true }).optional(),
  summary: z.string().max(4000).optional(),
  /** Data-plane pointer under analysis/ (Run Boundary). */
  receiptPath: z.string().max(500).optional(),
  items: z.array(AttemptItemSchema).max(50).optional(),
  usage: z
    .object({
      turns: z.number().int().nonnegative().optional(),
      contextTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type NodeAttempt = z.infer<typeof NodeAttemptSchema>;

export const RunGraphSnapshotSchema = z.object({
  topologyVersion: z.number().int().nonnegative(),
  topology: z.array(GraphNodeDefSchema).max(128),
  /** Append-only attempt log (capped for live SSE). */
  attempts: z.array(NodeAttemptSchema).max(256),
  playhead: z
    .object({
      nodeKey: z.string().trim().min(1).max(200),
      attemptId: z.string().trim().min(1).max(200),
    })
    .optional(),
});

export type RunGraphSnapshot = z.infer<typeof RunGraphSnapshotSchema>;

export const ControlReturnStatusSchema = z.enum(["complete", "partial", "failed", "cancelled"]);

export type ControlReturnStatus = z.infer<typeof ControlReturnStatusSchema>;

/**
 * Short control-plane handoff from a scoped agent loop.
 * Full evidence lives on disk via receiptPath (Run Boundary).
 */
export const ControlReturnSchema = z.object({
  attemptId: z.string().trim().min(1).max(200),
  nodeKey: z.string().trim().min(1).max(200),
  role: AttemptRoleSchema,
  status: ControlReturnStatusSchema,
  summary: z.string().max(4000),
  receiptPath: z.string().max(500).optional(),
  errorClass: ErrorClassSchema.optional(),
  pages: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
});

export type ControlReturn = z.infer<typeof ControlReturnSchema>;

export function emptyRunGraphSnapshot(topologyVersion = 0): RunGraphSnapshot {
  return {
    topologyVersion,
    topology: [],
    attempts: [],
  };
}
