export type WikiMode = "generate" | "refresh";

export interface SourceChange {
  status: string;
  paths: string[];
}

export interface WikiInspection {
  root: string;
  wikiRoot: string;
  mode: WikiMode;
  head: string;
  baseCommit: string | null;
  lastWikiCommit: string | null;
  changed: SourceChange[];
  changedPaths: string[];
  /** Hash of the current Git-derived source state, excluding wiki/. */
  sourceFingerprint: string;
  impactedPages: string[];
  wikiDrift: boolean;
}

export interface WikiValidation {
  ok: boolean;
  errors: string[];
  pages: string[];
}
