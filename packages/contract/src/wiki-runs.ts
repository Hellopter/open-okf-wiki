import { z } from "zod";
import { Sha256HexSchema } from "./primitives.js";
import { RepositorySnapshotSchema, WikiRunSpecSchema } from "./run.js";

/**
 * Durable WikiRuns contract version.
 * v3: RunIntent plus bounded plan.adapt.N evidence-gap decisions; no silent fan-out.
 * Definition topology is Wiki-specific, not a workflow DSL.
 */
export const WIKI_RUNS_SCHEMA = "okf.wiki-runs/v3" as const;
export const WikiRunDefinitionVersionSchema = z.literal(3);

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
  "plan.adapt",
  "research.leaf",
  "research.domain",
  "write.root",
  "validate.pre",
  "review.seat",
  "review.reduce",
  /** HITL after review.reduce when blocking defects are present (or auto-passed when clean). */
  "gate.fix",
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

/** Operator HITL kinds. `fix` is defect/quality review (pass | fix | revise | deny). */
export const WikiRunGateKindSchema = z.enum(["plan", "operator_input", "publication", "fix"]);
export const WikiRunGateStateSchema = z.enum(["open", "resolved", "withdrawn"]);
/** Decisions admitted on ResolveGate; validity is further refined per gateKind. */
export const WikiRunGateDecisionValueSchema = z.enum([
  "approve",
  "deny",
  "revise",
  "answer",
  "pass",
  "fix",
]);
export type WikiRunGateDecisionValue = z.infer<typeof WikiRunGateDecisionValueSchema>;
/** Operator decisions for an open fix gate. */
export const FixGateDecisionSchema = z.enum(["pass", "deny", "fix", "revise"]);
export type FixGateDecision = z.infer<typeof FixGateDecisionSchema>;
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
  "execution_plan",
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

/**
 * Operator intent for one Wiki Run (hard-cut: every StartRun carries intent).
 * Tool edge may still expose free-text `notes`; server maps notes → `focus`.
 */
export const RunIntentSchema = z
  .object({
    /** Operator focus / emphasis (was tool `notes`). */
    focus: z.string().trim().min(1).max(4_000).optional(),
    mode: z.enum(["generate", "refresh"]),
    objective: z.string().trim().min(1).max(4_000).optional(),
    constraints: z.string().trim().min(1).max(4_000).optional(),
    audience: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export type RunIntent = z.infer<typeof RunIntentSchema>;

export const StartRunCommandSchema = z
  .object({
    type: z.literal("start_run"),
    commandId: RunCommandIdSchema,
    /** Required hard-cut — no bare start_run without intent. */
    intent: RunIntentSchema,
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

/**
 * Resume one operator-approved evaluation recovery without recreating its Run.
 * The recovery record binds the original Candidate and sealed defect evidence.
 */
export const ContinueEvaluationCommandSchema = z
  .object({
    type: z.literal("continue_evaluation"),
    commandId: RunCommandIdSchema,
    runId: WikiRunIdSchema,
    recoveryId: IdentifierSchema,
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

function decisionAllowedForGateKind(
  gateKind: z.infer<typeof WikiRunGateKindSchema>,
  decision: WikiRunGateDecisionValue,
): boolean {
  if (gateKind === "operator_input") return decision === "answer";
  if (gateKind === "fix") {
    return (
      decision === "pass" || decision === "deny" || decision === "fix" || decision === "revise"
    );
  }
  // plan + publication
  return decision === "approve" || decision === "deny" || decision === "revise";
}

/**
 * Resolve an open gate. Decisions are refined by `gateKind`:
 * - plan / publication: `approve` | `deny` | `revise` (revise requires feedback)
 * - operator_input: `answer` (requires answer)
 * - fix (review defects after review.reduce):
 *   - `pass` — accept current wiki (waive / clean enough); unlock validate.final
 *   - `deny` — abandon run (failed)
 *   - `fix` — schedule repair.N (optional feedback notes)
 *   - `revise` — operator suggestions; re-open gate with new payload digest (requires feedback)
 */
export const ResolveGateCommandSchema = z
  .object({
    type: z.literal("resolve_gate"),
    commandId: RunCommandIdSchema,
    runId: WikiRunIdSchema,
    gateId: RunGateIdSchema,
    gateKind: WikiRunGateKindSchema,
    payloadDigest: Sha256HexSchema,
    decision: WikiRunGateDecisionValueSchema,
    feedback: z.string().trim().min(1).max(4_000).optional(),
    answer: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    const expectsAnswer = command.gateKind === "operator_input" && command.decision === "answer";
    if (!decisionAllowedForGateKind(command.gateKind, command.decision)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decision is not valid for gate kind",
        path: ["decision"],
      });
    }
    // revise requires feedback; fix may carry optional notes; all other decisions forbid it.
    if (command.decision === "revise") {
      if (!command.feedback) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "revise requires feedback",
          path: ["feedback"],
        });
      }
    } else if (command.decision === "fix") {
      // optional feedback/notes for repair.N — allowed
    } else if (command.feedback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feedback is only valid for revise or fix decisions",
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
  ContinueEvaluationCommandSchema,
  CancelRunCommandSchema,
  ResolveGateCommandSchema,
]);

export type StartRunCommand = z.infer<typeof StartRunCommandSchema>;
export type RetryFailedNodeCommand = z.infer<typeof RetryFailedNodeCommandSchema>;
export type RerunNodeCommand = z.infer<typeof RerunNodeCommandSchema>;
export type ContinueEvaluationCommand = z.infer<typeof ContinueEvaluationCommandSchema>;
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
    workUnitId: z.string().trim().min(1).max(120).optional(),
    adaptRound: z.number().int().min(1).max(2).optional(),
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

/**
 * Per-attempt observation metrics (Phase 0 baseline). Optional everywhere:
 * missing fields never block attempt completion or snapshot projection.
 * Persisted on SQLite `attempts` columns (+ metrics_json catch-all).
 */
export const AttemptMetricsSchema = z
  .object({
    /** Graph role: plan / leaf / domain / writer / review / repair / mechanical / … */
    role: z.string().trim().min(1).max(64).optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheTokens: z.number().int().nonnegative().optional(),
    costEstimate: z.number().finite().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    wallTimeMs: z.number().int().nonnegative().optional(),
    projectionBytes: z.number().int().nonnegative().optional(),
    stopReason: z.string().trim().min(1).max(128).optional(),
    /** Catch-all structured extras (SQLite metrics_json). */
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type AttemptMetrics = z.infer<typeof AttemptMetricsSchema>;

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
    /** Optional observation metrics when the attempt terminal path recorded them. */
    metrics: AttemptMetricsSchema.optional(),
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

/**
 * Optional operator-facing detail sealed when a gate opens (e.g. fix gate
 * blocking count / summary). Never carries full defect bodies or secrets.
 */
export const WikiRunGateDetailSchema = z
  .object({
    source: z.string().trim().min(1).max(100).optional(),
    summary: z.string().trim().max(4_000).optional(),
    clean: z.boolean().optional(),
    blockingCount: z.number().int().min(0).max(10_000).optional(),
    feedback: z.string().trim().max(4_000).optional(),
  })
  .strict();

export type WikiRunGateDetail = z.infer<typeof WikiRunGateDetailSchema>;

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
    /** Secret-free operator summary from sealed gate detail_json. */
    detail: WikiRunGateDetailSchema.optional(),
  })
  .strict()
  .superRefine((gate, ctx) => {
    if (gate.decision !== null) {
      const parsed = WikiRunGateDecisionValueSchema.safeParse(gate.decision.decision);
      const decisionOk = parsed.success && decisionAllowedForGateKind(gate.kind, parsed.data);
      if (!decisionOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "decision is not valid for gate kind",
          path: ["decision", "decision"],
        });
      }
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

/** Secret-free operator projection of a recoverable exhausted EvaluationRound. */
export const WikiRunEvaluationRecoverySchema = z
  .object({
    recoveryId: IdentifierSchema,
    candidateId: IdentifierSchema,
    source: z.enum(["mechanical", "semantic"]),
    repairRequestId: IdentifierSchema,
    reportArtifactId: IdentifierSchema.optional(),
    reason: z.string().trim().min(1).max(4_000),
    createdAt: IsoDateTimeSchema,
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
    /** Operator StartRun intent, sealed when the Run is accepted. */
    intent: RunIntentSchema,
    pinnedInputs: z
      .object({
        sources: z.array(RepositorySnapshotSchema).min(1),
        skillDigest: Sha256HexSchema,
        digest: Sha256HexSchema,
      })
      .strict()
      .nullable(),
    nodes: z.array(WikiRunNodeSchema),
    /** Actual durable DAG edges. Parent hierarchy is a secondary UI projection. */
    edges: z.array(z.object({ from: RunNodeKeySchema, to: RunNodeKeySchema }).strict()).default([]),
    attempts: z.array(WikiRunAttemptSchema),
    gates: z.array(WikiRunGateSchema),
    effects: z.array(WikiRunEffectSchema),
    /**
     * WikiCandidate lineage for evaluation (write / repair / mechanical_fix).
     * Empty when the run has not sealed a wiki_tree yet or on older DBs.
     */
    candidates: z
      .array(
        z
          .object({
            candidateId: z.string().min(1),
            digest: z.string().min(1),
            artifactId: z.string().min(1),
            parentCandidateId: z.string().min(1).optional(),
            producedBy: z.enum(["write", "repair", "mechanical_fix"]),
            round: z.number().int().min(0),
            createdAt: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    /** Present only while a failed Run has an operator-continuable evaluation recovery. */
    evaluationRecoveries: z.array(WikiRunEvaluationRecoverySchema).optional(),
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
  "evaluation.recovery_available",
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
export type WikiRunEvaluationRecovery = z.infer<typeof WikiRunEvaluationRecoverySchema>;
export type WikiRunSnapshot = z.infer<typeof WikiRunSnapshotSchema>;
export type WikiRunEvent = z.infer<typeof WikiRunEventSchema>;
export type WikiRunEventType = z.infer<typeof WikiRunEventTypeSchema>;
export type WikiRunSpecRead = z.infer<typeof WikiRunSpecReadSchema>;
export type RunCommandReceipt = z.infer<typeof RunCommandReceiptSchema>;
