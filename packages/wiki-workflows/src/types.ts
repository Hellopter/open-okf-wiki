export type WikiMode = "generate" | "refresh";

export interface SourceChange {
  status: string;
  paths: string[];
}

export interface WikiInspection {
  root: string;
  wikiRoot: string;
  /** Declared workspace source roots available to research agents. */
  sourcePaths: string[];
  mode: WikiMode;
  head: string;
  baseCommit: string | null;
  lastWikiCommit: string | null;
  changed: SourceChange[];
  changedPaths: string[];
  /** Hash of the current Git-derived source state, excluding wiki/. */
  sourceFingerprint: string;
  /** Sorted non-index Markdown pages present before this run starts. */
  existingPages: string[];
  impactedPages: string[];
  wikiDrift: boolean;
  /** Set when an existing pre-v0.2 Wiki cannot be incrementally refreshed. */
  refreshRequiresGenerateReason?: string;
}

export interface WikiValidationIssue {
  code: string;
  page?: string;
  message: string;
}

export interface WikiValidation {
  ok: boolean;
  issues: WikiValidationIssue[];
  pages: string[];
  obsoletePages: string[];
}

export interface WikiFinalization {
  pages: string[];
  obsoletePages: string[];
  removedPages: string[];
  rebuiltIndexes: string[];
}
