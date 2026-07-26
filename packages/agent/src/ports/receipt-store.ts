/**
 * Analysis receipt persistence port (path-first handoff, ADR 0011).
 *
 * Ports stay free of Pi SDK and produce/runtime modules — contract + local types only.
 * Core adapter implements via @okf-wiki/core analysis receipts.
 */

import type { AnalysisReceipt, ReceiptStatus } from "@okf-wiki/contract";

/** Minimal child result needed to attach a path-first receipt. */
export type ResearchChildResult = {
  role: string;
  summary: string;
  mode: "fixture" | "live";
  receiptPath?: string;
};

export type PersistReceiptInput = {
  workspaceRoot: string;
  runId: string;
  nodeId: string;
  parentId: string | null;
  scope: string;
  summary: string;
  status?: ReceiptStatus;
  childReceipts?: string[];
  openQuestions?: string[];
};

export type PersistReceiptResult = {
  receiptPath: string;
  relativePath: string;
  receipt: AnalysisReceipt;
};

export type AttachReceiptInput = {
  workspaceRoot: string;
  runId: string;
  nodeId: string;
  parentId: string | null;
  scope: string;
  status?: ReceiptStatus;
  childReceipts?: string[];
  openQuestions?: string[];
  /** Override summary (e.g. FAILED: …); defaults to child.summary. */
  summary?: string;
};

export type AttachReceiptResult = ResearchChildResult & {
  receiptPath: string;
  absoluteReceiptPath: string;
};

export type ReceiptListItem = {
  relativePath: string;
  status: ReceiptStatus;
  scope: string;
  summary: string;
};

/**
 * Write / index / list analysis receipts under the Run Boundary.
 */
export interface ReceiptStore {
  write(input: PersistReceiptInput): Promise<PersistReceiptResult>;
  attach(child: ResearchChildResult, input: AttachReceiptInput): Promise<AttachReceiptResult>;
  buildIndex(workspaceRoot: string, runId: string): Promise<string>;
  list(workspaceRoot: string, runId: string): Promise<ReceiptListItem[]>;
}
