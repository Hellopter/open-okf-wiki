/**
 * Public and internal types for the WikiRuns control plane (ADR 0035).
 * Package callers use WikiRuns / openWikiRuns only — ClaimedNode stays internal.
 */

import type {
  CandidateDiffRead,
  CandidatePageRead,
  CandidateTreeRead,
  WikiRunAttemptTranscript as ContractWikiRunAttemptTranscript,
  WikiRunListItem as ContractWikiRunListItem,
  PiAttemptExecutor,
  PiAttemptInput,
  PiAttemptOutcome,
  RunCommand,
  RunCommandContext,
  RunCommandReceipt,
  WikiRunArtifactKind,
  WikiRunEvent,
  WikiRunSnapshot,
  WikiRunSpecRead,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import type { FreezeRunBoundaryInput, FrozenRunBoundary } from "@okf-wiki/core";

/** Scheduler claim envelope for one ready node attempt (internal). */
export type ClaimedNode = {
  attemptId: string;
  nodeGeneration: number;
  nodeKey: string;
  kind: string;
  runId: string;
};

export type ClaimedFreeze = ClaimedNode;

export type PreparedFreeze = { workspace: WorkspaceConfig };

export type TrustedFrozenInputs = {
  skillDigest: string;
  sources: unknown;
};

export type ArtifactManifest = {
  schema: 1;
  files: Array<{ path: string; digest: string; size: number }>;
};

export type ArtifactPreparation = {
  artifactId: string;
  digest: string;
  kind: WikiRunArtifactKind;
  preparationId: string;
  relativePath: string;
  role: string;
  sourceDirectory: string;
};

export type PreparedFreezeArtifacts = {
  preparations: ArtifactPreparation[];
};

export type { PiAttemptExecutor, PiAttemptInput, PiAttemptOutcome };

export type OpenWikiRunsInput = {
  rootPath: string;
  piAttemptExecutor?: PiAttemptExecutor;
  /** Test seam for an abort-aware run-boundary freeze. */
  freezeRunBoundary?: (input: FreezeRunBoundaryInput) => Promise<FrozenRunBoundary>;
};

export type WikiRunRead = {
  snapshot: WikiRunSnapshot;
  events: WikiRunEvent[];
  cursor: number;
};

/** Contract-owned projections shared by workflow, server, and Web adapters. */
export type WikiRunListItem = ContractWikiRunListItem;
export type WikiRunAttemptTranscript = ContractWikiRunAttemptTranscript;

export interface WikiRuns {
  /** Every existing-Run mutation carries its observed control revision. */
  dispatch(command: RunCommand, context: RunCommandContext): Promise<RunCommandReceipt>;
  read(input: { runId: string; afterEventId?: number; limit?: number }): Promise<WikiRunRead>;
  /** Workspace-wide compact Run projection for the index SSE. */
  readIndex(input?: { afterEventId?: number; limit?: number }): Promise<{
    runs: WikiRunListItem[];
    cursor: number;
  }>;
  /**
   * Read-only Attempt transcript for Node details.
   * Resolves live `attempts/<id>/session.jsonl` or a sealed transcript artifact under the run.
   */
  readAttemptTranscript(input: {
    runId: string;
    attemptId: string;
    /** Exclusive cursor: return the newest page before this sequence. */
    beforeSequence?: number;
    /** Exclusive cursor: return entries after this sequence for SSE. */
    afterSequence?: number;
    limit?: number;
  }): Promise<WikiRunAttemptTranscript>;
  /**
   * Sealed plan Spec for operator review (GET …/runs/:runId/spec).
   * Throws `spec not found: <runId>` when no sealed plan output exists.
   */
  readPlanSpec(input: { runId: string }): Promise<WikiRunSpecRead>;
  /** Operator-safe candidate inspection; no artifact paths cross this boundary. */
  readCandidatePage(input: {
    runId: string;
    candidateDigest: string;
    pagePath: string;
  }): Promise<CandidatePageRead>;
  readCandidateTree(input: { runId: string; candidateDigest: string }): Promise<CandidateTreeRead>;
  readCandidateDiff(input: {
    runId: string;
    candidateDigest: string;
    pagePath: string;
  }): Promise<CandidateDiffRead>;
  /** Update the config captured by future StartRun commands; existing Runs remain sealed. */
  setWorkspaceForNewRuns(workspace: WorkspaceConfig): void;
  close(): Promise<void>;
}

export class WorkflowInUseError extends Error {
  readonly code = "WORKFLOW_IN_USE";

  constructor(rootPath: string, cause?: unknown) {
    super(
      `workflow is already open for workspace: ${rootPath}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "WorkflowInUseError";
  }
}

export class CommandIdCollision extends Error {
  readonly code = "COMMAND_ID_COLLISION";

  constructor(commandId: string) {
    super(`command id was already used with a different payload: ${commandId}`);
    this.name = "CommandIdCollision";
  }
}

/** Expected operator-facing failures at the WikiRuns boundary. */
export type WikiRunsRequestErrorCode =
  | "not_found"
  | "conflict"
  | "stale_revision"
  | "invalid_request"
  | "payload_too_large";

export class WikiRunsRequestError extends Error {
  constructor(
    readonly code: WikiRunsRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WikiRunsRequestError";
  }
}

/** Fail-closed cap for Attempt transcript reads (Node details UI). */
export const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
export const TRANSCRIPT_PAGE_DEFAULT_LIMIT = 100;
export const TRANSCRIPT_PAGE_MAX_LIMIT = 200;

export const DATABASE_FILE_NAME = "workflow.sqlite";

/**
 * L_control auto-retry budget for read-only research nodes (ADR 0013 / ADR 0035).
 *
 * WikiRuns may requeue research.leaf/domain ONCE (this cap = 2 total Attempts
 * per generation) for failureClass infrastructure|transient only, same
 * generation + input_digest. Never capacity|budget|policy|provider|cancelled.
 * Manual recovery remains RetryFailedNode / RerunNode.
 */
export const RESEARCH_AUTO_RETRY_MAX_ATTEMPTS = 2;
export const RESEARCH_AUTO_RETRY_KINDS: ReadonlySet<string> = new Set([
  "research.leaf",
  "research.domain",
]);
