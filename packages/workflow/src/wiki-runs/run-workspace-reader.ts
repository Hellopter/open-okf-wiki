/**
 * Read boundary for the independent Run Workspace.
 *
 * Routes receive only operator-safe projections from this module; artifact
 * paths remain internal to CandidateReview and the durable store.
 */

import type {
  CandidateDiffRead,
  CandidatePageRead,
  CandidateTreeRead,
  WikiRunListItem,
} from "@okf-wiki/contract";
import type { WikiRuns } from "./types.js";

export class RunWorkspaceReader {
  constructor(private readonly runs: WikiRuns) {}

  list(): Promise<WikiRunListItem[]> {
    return this.runs.list();
  }

  index(input?: { afterEventId?: number; limit?: number }): Promise<{
    runs: WikiRunListItem[];
    cursor: number;
  }> {
    return this.runs.readIndex(input);
  }

  candidatePage(input: {
    runId: string;
    candidateDigest: string;
    pagePath: string;
  }): Promise<CandidatePageRead> {
    return this.runs.readCandidatePage(input);
  }

  candidateTree(input: { runId: string; candidateDigest: string }): Promise<CandidateTreeRead> {
    return this.runs.readCandidateTree(input);
  }

  candidateDiff(input: {
    runId: string;
    candidateDigest: string;
    pagePath: string;
  }): Promise<CandidateDiffRead> {
    return this.runs.readCandidateDiff(input);
  }
}
