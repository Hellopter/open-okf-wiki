/**
 * Produce-owned Analysis Receipt helpers.
 * Implementation lives in ports/core-receipt-store (DIP); this module re-exports
 * convenience functions for call sites that do not inject ReceiptStore.
 */

import type { AnalysisReceipt, ReceiptStatus } from "@okf-wiki/contract";
import { defaultReceiptStore } from "../ports/core-receipt-store.js";
import type { ReceiptStore, ResearchChildResult } from "../ports/receipt-store.js";

export type { ResearchChildResult } from "../ports/receipt-store.js";

/**
 * Build research receipt fields and persist once through Core.
 * Canonical path: `{runWorkDir}/analysis/receipts/{nodeId}.json`
 */
export async function persistResearchReceipt(input: {
  workspaceRoot: string;
  runId: string;
  nodeId: string;
  parentId: string | null;
  scope: string;
  summary: string;
  status?: ReceiptStatus;
  childReceipts?: string[];
  openQuestions?: string[];
  store?: ReceiptStore;
}): Promise<{ receiptPath: string; relativePath: string; receipt: AnalysisReceipt }> {
  const store = input.store ?? defaultReceiptStore;
  return store.write(input);
}

/**
 * Persist a child research result and attach the relative receipt path as the
 * control-plane handle (path-first). Does not put receipt body on the child result.
 */
export async function attachResearchReceipt(
  child: ResearchChildResult,
  input: {
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
    store?: ReceiptStore;
  },
): Promise<ResearchChildResult & { receiptPath: string; absoluteReceiptPath: string }> {
  const store = input.store ?? defaultReceiptStore;
  return store.attach(child, input);
}

/**
 * Build a short index of receipt files for the Root writer prompt.
 */
export async function buildReceiptIndex(
  workspaceRoot: string,
  runId: string,
  store: ReceiptStore = defaultReceiptStore,
): Promise<string> {
  return store.buildIndex(workspaceRoot, runId);
}
