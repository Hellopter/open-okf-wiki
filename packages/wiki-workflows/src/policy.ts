/**
 * Tunable Wiki workflow budgets and limits.
 *
 * Pure module: no @earendil-works/* imports. Engine and future coordinator
 * read from DEFAULT_WIKI_WORKFLOW_POLICY (or a merged override).
 */

import { createHash } from "node:crypto";

export const WIKI_POLICY_VERSION = 3 as const;
export const WIKI_PROMPT_BUNDLE_VERSION = "domain-wiki-v2" as const;

export interface ResolvedWikiPolicy {
  version: typeof WIKI_POLICY_VERSION;
  exclude: string[];
  terminology: Record<string, string>;
  domains: Array<{ id: string; title: string; include: string[]; exclude: string[] }>;
  quality: { maxSubmissionAttempts: number };
  runtime: {
    maxConcurrentAgents: number;
    nodeTimeoutSeconds: number;
    maxTransientSessionAttempts: number;
    rateLimitCooldownSeconds: number;
  };
  promptBundleHash: string;
}

export function resolveWikiPolicy(value?: Partial<Omit<ResolvedWikiPolicy, "version" | "promptBundleHash">>): ResolvedWikiPolicy {
  return {
    version: WIKI_POLICY_VERSION,
    exclude: [...new Set(value?.exclude ?? [])].sort(),
    terminology: Object.fromEntries(Object.entries(value?.terminology ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    domains: (value?.domains ?? []).map((domain) => ({
      id: domain.id,
      title: domain.title,
      include: [...new Set(domain.include)].sort(),
      exclude: [...new Set(domain.exclude)].sort(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    quality: {
      maxSubmissionAttempts: boundedInteger(value?.quality?.maxSubmissionAttempts, 3, 1, 3, "quality.maxSubmissionAttempts"),
    },
    runtime: {
      maxConcurrentAgents: boundedInteger(value?.runtime?.maxConcurrentAgents, 2, 1, 4, "wiki.runtime.maxConcurrentAgents"),
      nodeTimeoutSeconds: boundedInteger(value?.runtime?.nodeTimeoutSeconds, 1_200, 60, 1_800, "wiki.runtime.nodeTimeoutSeconds"),
      maxTransientSessionAttempts: boundedInteger(value?.runtime?.maxTransientSessionAttempts, 2, 1, 2, "wiki.runtime.maxTransientSessionAttempts"),
      rateLimitCooldownSeconds: boundedInteger(value?.runtime?.rateLimitCooldownSeconds, 15, 15, 120, "wiki.runtime.rateLimitCooldownSeconds"),
    },
    promptBundleHash: createHash("sha256").update(WIKI_PROMPT_BUNDLE_VERSION).digest("hex"),
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

export function wikiPolicyHash(policy: ResolvedWikiPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

/** Artifact size ceilings (bytes); keep aligned with artifact-store. */
export interface WikiArtifactLimits {
  /** Canonical typed research JSON. */
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
  activityEventIntervalMs: 1000,
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
