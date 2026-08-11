/**
 * Tunable Wiki workflow budgets and limits.
 *
 * Pure module: no @earendil-works/* imports. Engine and future coordinator
 * read from DEFAULT_WIKI_WORKFLOW_POLICY (or a merged override).
 */

/** Artifact size ceilings (bytes); keep aligned with artifact-store. */
export interface WikiArtifactLimits {
  /** Research handoff JSON/markdown. */
  researchBytes: number;
  /** Model-authored control JSON (synthesis, review). */
  controlBytes: number;
  /** Absolute ceiling for any coordinator artifact. */
  maxBytes: number;
}

/**
 * Split research-round accounting: expand (coverage growth) is separate from
 * audit (dry coverage confirmation when critical gaps remain). Happy path with
 * no unresolved critical gaps skips dry-coverage audits entirely and goes
 * straight to writers (see afterSuccess synthesis + researchIdsHaveUnresolvedCriticalGaps).
 */
export interface WikiResearchBudgetPolicy {
  /** Max expand/coverage-growth research rounds (tighter happy path). */
  maxExpandRounds: number;
  /** Max audit/dry-coverage research rounds (only when critical gaps remain). */
  maxAuditRounds: number;
  /**
   * Legacy combined ceiling still used by the current engine pump.
   * Prefer maxExpandRounds + maxAuditRounds for new accounting.
   */
  maxResearchRounds: number;
  /**
   * Consecutive dry (no new critical findings) audits required before write
   * when research still reports unresolved critical gaps. Zero-gap happy path
   * skips this gate and does not spend audit rounds.
   */
  requiredDryCoverageAudits: number;
}

export interface WikiWorkflowPolicy {
  maxNodeAttempts: number;
  maxConcurrentResearchers: number;
  maxConcurrentWriters: number;
  maxLocalRepairRoundsPerPlan: number;
  maxStructuralResyntheses: number;
  /** Max expand scopes accepted from one synthesis expand decision. */
  maxExpandScopesPerBatch: number;
  /** Allowed source-fingerprint restart loops per run. */
  maxSourceRestarts: number;
  research: WikiResearchBudgetPolicy;
  maxNodeOutputChars: number;
  maxNodeHistoryEntries: number;
  maxNodeHistoryChars: number;
  maxEvents: number;
  activityEventIntervalMs: number;
  artifacts: WikiArtifactLimits;
}

export const DEFAULT_WIKI_WORKFLOW_POLICY: WikiWorkflowPolicy = {
  maxNodeAttempts: 3,
  maxConcurrentResearchers: 4,
  maxConcurrentWriters: 4,
  maxLocalRepairRoundsPerPlan: 3,
  maxStructuralResyntheses: 1,
  maxExpandScopesPerBatch: 4,
  maxSourceRestarts: 1,
  research: {
    // Split accounting: expand budget is independent of audit budget.
    // Zero-gap happy path skips audits; gap-closing paths still pay dry audits.
    maxExpandRounds: 4,
    maxAuditRounds: 3,
    maxResearchRounds: 6,
    // When critical gaps remain, one consecutive dry coverage audit is enough before write.
    requiredDryCoverageAudits: 1,
  },
  maxNodeOutputChars: 48 * 1024,
  maxNodeHistoryEntries: 48,
  maxNodeHistoryChars: 24 * 1024,
  maxEvents: 200,
  activityEventIntervalMs: 250,
  artifacts: {
    researchBytes: 256 * 1024,
    controlBytes: 256 * 1024,
    maxBytes: 1024 * 1024,
  },
};

/** Integer research-round limit accepted on run start / workspace quality. */
export function validMaxResearchRounds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WIKI_WORKFLOW_POLICY.research.maxResearchRounds;
  if (!Number.isInteger(value) || value < 3 || value > 20) {
    throw new Error("maxResearchRounds must be an integer from 3 to 20");
  }
  return value;
}

export type PartialWikiWorkflowPolicy = {
  [K in keyof WikiWorkflowPolicy]?: K extends "research" | "artifacts"
    ? Partial<WikiWorkflowPolicy[K]>
    : WikiWorkflowPolicy[K];
};

/** Shallow-merge top-level fields; deep-merge research and artifacts. */
export function mergeWikiWorkflowPolicy(partial?: PartialWikiWorkflowPolicy): WikiWorkflowPolicy {
  if (!partial) return { ...DEFAULT_WIKI_WORKFLOW_POLICY, research: { ...DEFAULT_WIKI_WORKFLOW_POLICY.research }, artifacts: { ...DEFAULT_WIKI_WORKFLOW_POLICY.artifacts } };
  return {
    ...DEFAULT_WIKI_WORKFLOW_POLICY,
    ...partial,
    research: {
      ...DEFAULT_WIKI_WORKFLOW_POLICY.research,
      ...partial.research,
    },
    artifacts: {
      ...DEFAULT_WIKI_WORKFLOW_POLICY.artifacts,
      ...partial.artifacts,
    },
  };
}
