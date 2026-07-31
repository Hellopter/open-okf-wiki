import { z } from "zod";

/** Repository-relative POSIX-style ignore globs (product contract; not OS paths). */
export const IgnorePatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (pattern) =>
      !pattern.includes("\\") &&
      !pattern.includes("\0") &&
      !pattern.startsWith("/") &&
      !pattern.split("/").some((part) => part === "" || part === "." || part === ".."),
    { message: "ignore patterns must be repository-relative POSIX globs" },
  );

export const SourceIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "source id must be a lowercase slug");

/**
 * How a source was attached to the Workspace.
 * - path: operator linked an existing local checkout (may be outside rootPath)
 * - clone: product cloned a remote into the Workspace (under rootPath/sources/…)
 */
export const SourceOriginSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("path"),
  }),
  z.object({
    type: z.literal("clone"),
    remoteUrl: z.string().trim().min(1).max(2000),
    /** Optional ref requested at clone time (branch/tag/commit). */
    ref: z.string().trim().min(1).max(200).optional(),
    clonedAt: z.string().datetime(),
  }),
]);

export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

/**
 * One local Git working tree used as a Wiki source.
 * Path is always absolute after registration. May live inside or outside Workspace rootPath.
 */
export const WorkspaceSourceSchema = z
  .object({
    id: SourceIdSchema,
    /** Absolute filesystem path to a local Git checkout. */
    path: z.string().trim().min(1),
    applyDefaultIgnores: z.boolean().default(true),
    ignore: z.array(IgnorePatternSchema).default([]),
    /** How the source was attached. Always set on write. */
    origin: SourceOriginSchema,
  })
  .strict();

export type WorkspaceSource = z.infer<typeof WorkspaceSourceSchema>;

/**
 * Workspace model selection.
 * Credentials and base URL live in Settings model profiles only.
 * `id` is a denormalized modelId for display; `profileId` is the catalog key.
 */
export const ModelRefSchema = z.object({
  /**
   * Served model identity (denormalized from the selected profile), e.g.
   * `openai/my-served-model`. Kept so overview still renders if the profile
   * was deleted.
   */
  id: z.string().trim().min(1),
  /** Reference to a machine-local Settings model profile. */
  profileId: z.string().trim().min(1).optional(),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Per-provider retry caps (mirrors Pi settings.retry.provider 1:1). */
export const RetryProviderLimitsSchema = z.object({
  maxRetries: z.number().int().min(0).max(5).default(0),
  maxRetryDelayMs: z.number().int().min(0).max(600_000).default(60_000),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});

export type RetryProviderLimits = z.infer<typeof RetryProviderLimitsSchema>;

/**
 * Workspace retry policy (mirrors Pi settings.retry 1:1).
 * `maxRetries` is extra attempts after the first call (default 2 → 3 total).
 */
export const RetryLimitsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Extra attempts after first call (Pi maxRetries). Default 2 → 3 total. */
  maxRetries: z.number().int().min(0).max(10).default(2),
  baseDelayMs: z.number().int().min(100).max(60_000).default(2000),
  provider: RetryProviderLimitsSchema.default(() => RetryProviderLimitsSchema.parse({})),
});

export type RetryLimits = z.infer<typeof RetryLimitsSchema>;

export const WorkspaceLimitsSchema = z.object({
  /**
   * Wall-clock budget (seconds) for one child agent session
   * (plan / domain / leaf / write / review). Applied as timeoutMs in the
   * live produce runtime. Default 600s — short enough to bound stuck runs,
   * long enough for typical plan turns. Operators can raise this in workspace
   * settings when large repos need more time.
   */
  requestTimeoutSeconds: z.number().positive().max(86_400).default(600),
  /**
   * Operational context budget for Wiki Run message compaction (tokens).
   * Not the provider hard window — that lives on the model profile as
   * `maxContextTokens`. When unset, the agent derives a target from
   * profile maxContextTokens × 0.85 when available.
   */
  contextTargetTokens: z.number().int().positive().max(10_000_000).optional(),
  /** Retry policy for provider/transient failures (Pi settings.retry shape). */
  retry: RetryLimitsSchema.default(() => RetryLimitsSchema.parse({})),
  /**
   * Wall-clock budget (seconds) for an open operator gate (plan / publication).
   * When > 0, WikiRuns auto-denies stale open gates after this many seconds.
   * Omit or 0 disables gate timeout.
   */
  gateTimeoutSeconds: z.number().int().min(0).max(604_800).optional(),
});

export type WorkspaceLimits = z.infer<typeof WorkspaceLimitsSchema>;

/**
 * Partial limits for workspace PATCH (deep-merged onto existing limits, then re-parsed).
 * Avoids wiping retry/context when the client sends a single field.
 */
export const WorkspaceLimitsPatchSchema = z
  .object({
    requestTimeoutSeconds: z.number().positive().max(86_400).optional(),
    contextTargetTokens: z.number().int().positive().max(10_000_000).optional(),
    gateTimeoutSeconds: z.number().int().min(0).max(604_800).optional(),
    retry: z
      .object({
        enabled: z.boolean().optional(),
        maxRetries: z.number().int().min(0).max(10).optional(),
        baseDelayMs: z.number().int().min(100).max(60_000).optional(),
        provider: z
          .object({
            maxRetries: z.number().int().min(0).max(5).optional(),
            maxRetryDelayMs: z.number().int().min(0).max(600_000).optional(),
            timeoutMs: z.number().int().positive().max(3_600_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkspaceLimitsPatch = z.infer<typeof WorkspaceLimitsPatchSchema>;

/**
 * Role → model mapping for planner/worker economics (Cursor-style hybrid).
 * When a role is omitted, the agent falls back to workspace.model.
 */
export const WorkspaceRoleModelsSchema = z.object({
  /** Root planner / synthesis / hard repairs. */
  planner: ModelRefSchema.optional(),
  /** Domain / Leaf research workers (prefer cheaper/faster). */
  worker: ModelRefSchema.optional(),
  /** Optional dedicated page writer; defaults to planner. */
  writer: ModelRefSchema.optional(),
  /**
   * Independent reviewer model(s). Multiple entries enable a decorrelated council.
   * Empty → fall back to workspace.model for a single reviewer.
   */
  reviewers: z.array(ModelRefSchema).max(4).default([]),
});

export type WorkspaceRoleModels = z.infer<typeof WorkspaceRoleModelsSchema>;

/**
 * Supervisor-tree budgets: fan-out/council enforced by produce / WikiRuns.
 * Turn budgets are abort/timeout only.
 * Unknown legacy keys (e.g. rootMaxSteps) are stripped on parse.
 */
export const WorkspaceOrchestrationSchema = z
  .object({
    /** Cap domains materialized from Spec (topology). */
    maxDomainFanOut: z.number().int().min(1).max(16).default(4),
    /**
     * Cap questions/leaves per domain (topology only — not the leaf concurrency pool).
     * Scheduler leaf pool is separate: domainConcurrency × min(leafConcurrency, maxLeafFanOut).
     */
    maxLeafFanOut: z.number().int().min(1).max(16).default(6),
    /**
     * Independent review council size (Run Boundary-owned).
     * Default 1 (light path). Raise for multi-lens ensemble
     * (grounding/coverage/consistency). Pad with same model + different prompts when
     * only one reviewer profile is configured.
     */
    reviewCouncilSize: z.number().int().min(1).max(4).default(1),
    /**
     * How many review council members may run concurrently.
     * Defaults to `reviewCouncilSize` when omitted.
     */
    reviewConcurrency: z.number().int().min(1).max(4).optional(),
    /**
     * Parallel plan scouts before the Spec synthesizer (entry / layout / tests).
     * 0 disables scouts (single planner only; light-path default).
     * Raise when inventory shows large/multi-entry or plan uncertainty.
     */
    planScoutCount: z.number().int().min(0).max(4).default(0),
    /**
     * How many plan scouts may run concurrently.
     * Defaults to `planScoutCount` when omitted.
     */
    planScoutConcurrency: z.number().int().min(1).max(4).optional(),
    /**
     * How many domain research units may run concurrently (each unit is
     * leaf fan-out + domain reduce). Domains have independent scopes, so
     * this bounds wall-clock, not correctness. Also scales the shared leaf
     * pool with leafConcurrency.
     */
    domainConcurrency: z.number().int().min(1).max(8).default(2),
    /**
     * Per-domain leaf parallel width. Total leaf slots =
     * domainConcurrency × min(leafConcurrency, maxLeafFanOut).
     */
    leafConcurrency: z.number().int().min(1).max(16).default(2),
  })
  .strict();

export type WorkspaceOrchestration = z.infer<typeof WorkspaceOrchestrationSchema>;

/** Schema defaults are the sole authority for orchestration budgets. */
export const DEFAULT_ORCHESTRATION: WorkspaceOrchestration = WorkspaceOrchestrationSchema.parse({});

/**
 * Canonical merge of partial orchestration onto schema defaults.
 * Sole resolve path for produce, WikiRuns scheduler, and plan-phase — do not
 * reimplement field-by-field defaults elsewhere.
 */
export function resolveOrchestration(
  o?: Partial<WorkspaceOrchestration> | null,
): WorkspaceOrchestration {
  if (!o) return { ...DEFAULT_ORCHESTRATION };
  const reviewCouncilSize = o.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize;
  const planScoutCount = o.planScoutCount ?? DEFAULT_ORCHESTRATION.planScoutCount;
  return {
    maxDomainFanOut: o.maxDomainFanOut ?? DEFAULT_ORCHESTRATION.maxDomainFanOut,
    maxLeafFanOut: o.maxLeafFanOut ?? DEFAULT_ORCHESTRATION.maxLeafFanOut,
    reviewCouncilSize,
    ...(o.reviewConcurrency !== undefined ? { reviewConcurrency: o.reviewConcurrency } : {}),
    planScoutCount,
    ...(o.planScoutConcurrency !== undefined
      ? { planScoutConcurrency: o.planScoutConcurrency }
      : {}),
    domainConcurrency: o.domainConcurrency ?? DEFAULT_ORCHESTRATION.domainConcurrency,
    leafConcurrency: o.leafConcurrency ?? DEFAULT_ORCHESTRATION.leafConcurrency,
  };
}

/**
 * Tools selectable for the Operator Session (chat agent). The fs tools are
 * Operations-scoped read-only; `bash` is an explicit trust opt-in — it is a
 * stock Pi tool with no Operations wrapper, so it can reach `.okf-wiki/`.
 * Wiki Run child sessions keep their fixed role policies regardless.
 *
 * Default selection omits `bash` (trust opt-in). Agent `tool-policy` imports
 * this list and `OperatorToolNameSchema` so the wire config and runtime stay aligned.
 */
export const OperatorToolNameSchema = z.enum(["read", "grep", "find", "ls", "bash"]);

export type OperatorToolName = z.infer<typeof OperatorToolNameSchema>;

export const DEFAULT_OPERATOR_TOOLS: readonly OperatorToolName[] = ["read", "grep", "find", "ls"];

export const OperatorToolsSchema = z
  .array(OperatorToolNameSchema)
  .max(8)
  .transform((tools) => [...new Set(tools)]);

/**
 * Language for generated Wiki page content (not the operator UI locale).
 * Default English; Chinese is Simplified Chinese prose.
 */
export const WikiLanguageSchema = z.enum(["en", "zh"]);

export type WikiLanguage = z.infer<typeof WikiLanguageSchema>;

/**
 * Optional operator ignore presets (never applied automatically).
 * The product expands these into additive user `ignore` patterns when selected in the UI.
 */
export const IGNORE_PRESETS: Readonly<
  Record<string, { label: string; patterns: readonly string[] }>
> = Object.freeze({
  "java-tests": Object.freeze({
    label: "Java tests",
    patterns: Object.freeze([
      "src/test/**",
      "**/src/test/**",
      "**/*Test.java",
      "**/*Tests.java",
      "**/*IT.java",
      "**/*ITCase.java",
    ]),
  }),
  "js-tests": Object.freeze({
    label: "JS/TS tests",
    patterns: Object.freeze([
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.test.js",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.spec.js",
      "**/__tests__/**",
      "**/__mocks__/**",
    ]),
  }),
  "python-tests": Object.freeze({
    label: "Python tests",
    patterns: Object.freeze([
      "tests/**",
      "**/tests/**",
      "test/**",
      "**/test/**",
      "**/test_*.py",
      "**/*_test.py",
    ]),
  }),
});

/**
 * Operator project (Workspace). Distinct from run-local analysis scratch.
 * Secrets must never appear in this document.
 */
export const WorkspaceConfigSchema = z
  .object({
    version: z.literal(2),
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    /** Absolute path to the workspace root directory. */
    rootPath: z.string().trim().min(1),
    /** Empty until the operator adds at least one local Git source. */
    sources: z.array(WorkspaceSourceSchema).default([]),
    model: ModelRefSchema,
    /** Absolute path for the Published Wiki tree (same-volume rules apply at prepare). */
    publicationPath: z.string().trim().min(1),
    limits: WorkspaceLimitsSchema.default(() => WorkspaceLimitsSchema.parse({})),
    /**
     * Optional per-role models (planner / worker / reviewers).
     * Omitted roles use `model`.
     */
    roleModels: WorkspaceRoleModelsSchema.default(() => WorkspaceRoleModelsSchema.parse({})),
    /** Supervisor tree fan-out, concurrency, and review council size. */
    orchestration: WorkspaceOrchestrationSchema.default(() => ({ ...DEFAULT_ORCHESTRATION })),
    /**
     * When true, interactive Wiki Runs pause for operator Spec confirmation
     * before produce. Headless/autoApprove skips this gate.
     */
    // HITL by default: interactive runs pause for operator plan approval.
    planConfirm: z.boolean().default(true),
    /**
     * Operator Session tool selection (all, partial, or none of the selectable
     * tools). Defaults to the Operations-scoped read-only set; `bash` only via
     * explicit opt-in.
     */
    operatorTools: OperatorToolsSchema.default([...DEFAULT_OPERATOR_TOOLS]),
    /**
     * Output language for Wiki page body and titles produced by Wiki Runs.
     * Independent of the operator UI locale.
     */
    wikiLanguage: WikiLanguageSchema.default("en"),
    /**
     * Optional path to a project Producer Skill
     * (`{root}/.agents/skills/repository-wiki-producer`).
     * Omit to resolve home (`~/.agents/skills`) or package default.
     */
    skillPath: z.string().trim().min(1).optional(),
    createdAt: z.string().datetime(),
    lastOpenedAt: z.string().datetime().optional(),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/**
 * App-index list row (not the full WorkspaceConfig document).
 * Shared by API, Web, and core listWorkspaceSummaries. Outbound only.
 */
export type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt?: string;
  sourceCount: number;
};

/** Result of probing a local Git path (no network). Outbound only. */
export type GitProbe = {
  path: string;
  isGit: boolean;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  error: string | null;
};
