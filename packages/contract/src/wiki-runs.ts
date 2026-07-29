import { z } from "zod";
import { Sha256HexSchema } from "./primitives.js";
import { RepositorySnapshotSchema, WikiRunSpecSchema } from "./run.js";

/** Durable WikiRuns contract version. Definition v1 is Wiki-specific, not a workflow DSL. */
export const WIKI_RUNS_SCHEMA = "okf.wiki-runs/v1" as const;
export const WikiRunDefinitionVersionSchema = z.literal(1);

const IdentifierSchema = z.string().trim().min(1).max(200);
const IsoDateTimeSchema = z.string().datetime();

export const WorkspaceIdSchema = IdentifierSchema;
export const WikiRunIdSchema = IdentifierSchema;
export const RunCommandIdSchema = IdentifierSchema;
export const RunNodeKeySchema = z.string().trim().min(1).max(200);
export const RunAttemptIdSchema = IdentifierSchema;
export const RunGateIdSchema = IdentifierSchema;

export const WikiRunStateSchema = z.enum([
  "queued",
  "running",
  "waiting_for_operator",
  "failed",
  "publication_declined",
  "completed_unpublished",
  "published",
  "cancelling",
  "cancelled",
]);

export const WikiRunNodeKindSchema = z.enum([
  "freeze",
  "plan",
  "gate.plan",
  "research.leaf",
  "research.domain",
  "write.root",
  "validate.pre",
  "review.seat",
  "review.reduce",
  "repair",
  "validate.final",
  "prepare.publication",
  "gate.publication",
  "publish",
]);

export const WikiRunNodeStateSchema = z.enum([
  "blocked",
  "ready",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "invalidated",
  "cancelled",
]);

export const WikiRunAttemptStateSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "suspended",
  "cancelled",
]);

export const WikiRunGateKindSchema = z.enum(["plan", "operator_input", "publication"]);
export const WikiRunGateStateSchema = z.enum(["open", "resolved", "withdrawn"]);
export const WikiRunEffectStateSchema = z.enum([
  "prepared",
  "candidate_ready",
  "applying",
  "applied",
  "conflict",
  "failed",
  "unknown",
  "cancelled",
]);
export const WikiRunArtifactKindSchema = z.enum([
  "snapshot_set",
  "skill",
  "spec",
  "receipt",
  "wiki_tree",
  "gate_payload",
  "transcript",
  "manifest",
  "operator_input",
  "publication_candidate",
]);

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type WikiRunId = z.infer<typeof WikiRunIdSchema>;
export type RunCommandId = z.infer<typeof RunCommandIdSchema>;
export type WikiRunDefinitionVersion = z.infer<typeof WikiRunDefinitionVersionSchema>;
export type WikiRunState = z.infer<typeof WikiRunStateSchema>;
export type WikiRunNodeKind = z.infer<typeof WikiRunNodeKindSchema>;
export type WikiRunNodeState = z.infer<typeof WikiRunNodeStateSchema>;
export type WikiRunAttemptState = z.infer<typeof WikiRunAttemptStateSchema>;
export type WikiRunGateKind = z.infer<typeof WikiRunGateKindSchema>;
export type WikiRunGateState = z.infer<typeof WikiRunGateStateSchema>;
export type WikiRunEffectState = z.infer<typeof WikiRunEffectStateSchema>;
export type WikiRunArtifactKind = z.infer<typeof WikiRunArtifactKindSchema>;

/**
 * Trusted dispatch metadata. The HTTP and Pi adapters derive this from their
 * authenticated route/session; it is never parsed from a command body.
 */
export const RunCommandContextSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    actor: z
      .object({
        id: IdentifierSchema,
        kind: z.enum(["local_operator", "operator_session"]),
      })
      .strict(),
    sessionId: IdentifierSchema.optional(),
  })
  .strict();

export type RunCommandContext = z.infer<typeof RunCommandContextSchema>;

export const StartRunCommandSchema = z
  .object({
    type: z.literal("start_run"),
    commandId: RunCommandIdSchema,
  })
  .strict();

export const RetryFailedNodeCommandSchema = z
  .object({
    type: z.literal("retry_failed_node"),
    commandId: RunCommandIdSchema,
    runId: WikiRunIdSchema,
    nodeKey: RunNodeKeySchema,
    generation: z.number().int().min(0),
    attemptId: RunAttemptIdSchema,
  })
  .strict();

export const RerunNodeCommandSchema = z
  .object({
    type: z.literal("rerun_node"),
    commandId: RunCommandIdSchema,
    runId: WikiRunIdSchema,
    nodeKey: RunNodeKeySchema,
    generation: z.number().int().min(0),
    feedback: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

export const CancelRunCommandSchema = z
  .object({
    type: z.literal("cancel_run"),
    commandId: RunCommandIdSchema,
    runId: WikiRunIdSchema,
  })
  .strict();

export const ResolveGateCommandSchema = z
  .object({
    type: z.literal("resolve_gate"),
    commandId: RunCommandIdSchema,
    runId: WikiRunIdSchema,
    gateId: RunGateIdSchema,
    gateKind: WikiRunGateKindSchema,
    payloadDigest: Sha256HexSchema,
    decision: z.enum(["approve", "deny", "revise", "answer"]),
    feedback: z.string().trim().min(1).max(4_000).optional(),
    answer: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    const expectsFeedback = command.decision === "revise";
    const expectsAnswer = command.gateKind === "operator_input" && command.decision === "answer";
    const decisionAllowed =
      (command.gateKind === "operator_input" && command.decision === "answer") ||
      (command.gateKind !== "operator_input" &&
        ["approve", "deny", "revise"].includes(command.decision));
    if (!decisionAllowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decision is not valid for gate kind",
        path: ["decision"],
      });
    }
    if (Boolean(command.feedback) !== expectsFeedback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revise requires feedback only",
        path: ["feedback"],
      });
    }
    if (Boolean(command.answer) !== expectsAnswer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "operator input requires answer only",
        path: ["answer"],
      });
    }
  });

export const RunCommandSchema = z.discriminatedUnion("type", [
  StartRunCommandSchema,
  RetryFailedNodeCommandSchema,
  RerunNodeCommandSchema,
  CancelRunCommandSchema,
  ResolveGateCommandSchema,
]);

export type StartRunCommand = z.infer<typeof StartRunCommandSchema>;
export type RetryFailedNodeCommand = z.infer<typeof RetryFailedNodeCommandSchema>;
export type RerunNodeCommand = z.infer<typeof RerunNodeCommandSchema>;
export type CancelRunCommand = z.infer<typeof CancelRunCommandSchema>;
export type ResolveGateCommand = z.infer<typeof ResolveGateCommandSchema>;
export type RunCommand = z.infer<typeof RunCommandSchema>;

/** Workspace + command id is the durable idempotency key. */
export const RunCommandKeySchema = z
  .object({ workspaceId: WorkspaceIdSchema, commandId: RunCommandIdSchema })
  .strict();
export type RunCommandKey = z.infer<typeof RunCommandKeySchema>;

export const WikiRunArtifactSchema = z
  .object({
    artifactId: IdentifierSchema,
    kind: WikiRunArtifactKindSchema,
    digest: Sha256HexSchema,
    sealedAt: IsoDateTimeSchema,
  })
  .strict();

export const WikiRunNodeOutputSchema = z
  .object({
    role: z.string().trim().min(1).max(100),
    artifact: WikiRunArtifactSchema,
  })
  .strict();

/**
 * Secret-free operator-facing node detail (from sealed definition detail_json).
 * Never carries provider secrets or full Spec bodies.
 */
export const WikiRunNodeDetailSchema = z
  .object({
    domainId: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().max(500).optional(),
    question: z.string().trim().max(4_000).optional(),
    questionIndex: z.number().int().positive().optional(),
    scope: z.string().trim().max(2_000).optional(),
    lens: z.string().trim().min(1).max(100).optional(),
    critical: z.boolean().optional(),
  })
  .strict();

export const WikiRunNodeSchema = z
  .object({
    key: RunNodeKeySchema,
    kind: WikiRunNodeKindSchema,
    state: WikiRunNodeStateSchema,
    generation: z.number().int().min(0),
    currentAttemptId: RunAttemptIdSchema.nullable(),
    lastAttemptId: RunAttemptIdSchema.nullable(),
    outputs: z.array(WikiRunNodeOutputSchema),
    /** Operator chip label (projected; not a durable control key). */
    label: z.string().trim().min(1).max(200),
    /** Optional parent for research hierarchy tooltips (leaf → domain → plan). */
    parentKey: RunNodeKeySchema.optional(),
    detail: WikiRunNodeDetailSchema.optional(),
  })
  .strict();

/**
 * GET …/runs/:runId/spec — sealed plan Spec for operator review (not on snapshot SSE).
 */
export const WikiRunSpecReadSchema = z
  .object({
    runId: WikiRunIdSchema,
    artifactId: IdentifierSchema.optional(),
    digest: Sha256HexSchema,
    spec: WikiRunSpecSchema,
  })
  .strict();

export const WikiRunAttemptSchema = z
  .object({
    attemptId: RunAttemptIdSchema,
    nodeKey: RunNodeKeySchema,
    nodeGeneration: z.number().int().min(0),
    runIndex: z.number().int().positive(),
    state: WikiRunAttemptStateSchema,
    inputDigest: Sha256HexSchema,
    error: z.string().max(4_000).nullable(),
    /**
     * Typed failure class from the Attempt executor (Pi or mechanical), when known.
     * Persisted on the control store for L_control research auto-retry policy
     * and Run Graph observation (ADR 0013 / ADR 0035).
     */
    failureClass: z.string().trim().min(1).max(64).optional(),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const WikiRunGateDecisionSchema = z
  .object({
    commandId: RunCommandIdSchema,
    decision: z.string().trim().min(1).max(32),
    payloadDigest: Sha256HexSchema,
    decidedAt: IsoDateTimeSchema,
  })
  .strict();

export const WikiRunGateSchema = z
  .object({
    gateId: RunGateIdSchema,
    nodeKey: RunNodeKeySchema,
    nodeGeneration: z.number().int().min(0),
    kind: WikiRunGateKindSchema,
    state: WikiRunGateStateSchema,
    payloadDigest: Sha256HexSchema,
    decision: WikiRunGateDecisionSchema.nullable(),
    openedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((gate, ctx) => {
    const decisionAllowed =
      gate.decision === null ||
      (gate.kind === "operator_input" && gate.decision.decision === "answer") ||
      (gate.kind !== "operator_input" &&
        ["approve", "deny", "revise"].includes(gate.decision.decision));
    if (!decisionAllowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decision is not valid for gate kind",
        path: ["decision", "decision"],
      });
    }
    if ((gate.state === "resolved") !== (gate.decision !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only a resolved gate has a decision",
        path: ["decision"],
      });
    }
  });

export const WikiRunEffectSchema = z
  .object({
    effectKey: IdentifierSchema,
    publicationNodeKey: RunNodeKeySchema,
    publicationNodeGeneration: z.number().int().min(0),
    gateId: RunGateIdSchema,
    state: WikiRunEffectStateSchema,
    requestDigest: Sha256HexSchema,
    expectedLiveDigest: Sha256HexSchema,
    candidateArtifactId: IdentifierSchema,
    candidateDigest: Sha256HexSchema,
  })
  .strict();

export const WikiRunSnapshotSchema = z
  .object({
    schema: z.literal(WIKI_RUNS_SCHEMA),
    definitionVersion: WikiRunDefinitionVersionSchema,
    runId: WikiRunIdSchema,
    workspaceId: WorkspaceIdSchema,
    revision: z.number().int().min(0),
    state: WikiRunStateSchema,
    cancelRequested: z.boolean(),
    pinnedInputs: z
      .object({
        sources: z.array(RepositorySnapshotSchema).min(1),
        skillDigest: Sha256HexSchema,
        digest: Sha256HexSchema,
      })
      .strict()
      .nullable(),
    nodes: z.array(WikiRunNodeSchema),
    attempts: z.array(WikiRunAttemptSchema),
    gates: z.array(WikiRunGateSchema),
    effects: z.array(WikiRunEffectSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const WikiRunEventTypeSchema = z.enum([
  "run.started",
  "inputs.pinned",
  "node.ready",
  "attempt.started",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.interrupted",
  "gate.opened",
  "gate.resolved",
  "gate.withdrawn",
  "run.cancel_requested",
  "run.cancelled",
  "run.completed_unpublished",
  "effect.prepared",
  "effect.candidate_ready",
  "effect.applying",
  "effect.applied",
  "effect.conflict",
  "effect.failed",
  "effect.unknown",
  "run.published",
]);

/** Durable low-frequency event. The full snapshot makes SSE replay deterministic. */
export const WikiRunEventSchema = z
  .object({
    runId: WikiRunIdSchema,
    eventId: z.number().int().min(0),
    revision: z.number().int().min(0),
    type: WikiRunEventTypeSchema,
    occurredAt: IsoDateTimeSchema,
    snapshot: WikiRunSnapshotSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.snapshot.runId !== event.runId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event runId must match snapshot",
        path: ["snapshot", "runId"],
      });
    }
    if (event.snapshot.revision !== event.revision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event revision must match snapshot",
        path: ["snapshot", "revision"],
      });
    }
  });

export const RunCommandReceiptSchema = z
  .object({
    commandId: RunCommandIdSchema,
    runId: WikiRunIdSchema,
    revision: z.number().int().min(0),
    accepted: z.boolean(),
  })
  .strict();

export type WikiRunArtifact = z.infer<typeof WikiRunArtifactSchema>;
export type WikiRunNode = z.infer<typeof WikiRunNodeSchema>;
export type WikiRunNodeDetail = z.infer<typeof WikiRunNodeDetailSchema>;
export type WikiRunAttempt = z.infer<typeof WikiRunAttemptSchema>;
export type WikiRunGate = z.infer<typeof WikiRunGateSchema>;
export type WikiRunEffect = z.infer<typeof WikiRunEffectSchema>;
export type WikiRunSnapshot = z.infer<typeof WikiRunSnapshotSchema>;
export type WikiRunEvent = z.infer<typeof WikiRunEventSchema>;
export type WikiRunEventType = z.infer<typeof WikiRunEventTypeSchema>;
export type WikiRunSpecRead = z.infer<typeof WikiRunSpecReadSchema>;
export type RunCommandReceipt = z.infer<typeof RunCommandReceiptSchema>;
