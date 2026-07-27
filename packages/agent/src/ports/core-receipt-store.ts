/**
 * ReceiptStore adapter over Core analysis receipts + product findings shaping.
 *
 * Uses @okf-wiki/core only (ports ban produce/ and Pi). Call sites inject
 * ReceiptStore or use defaultReceiptStore — no produce/ pass-through wrappers.
 */

import {
  type AnalysisReceipt,
  AnalysisReceiptSchema,
  type ReceiptStatus,
} from "@okf-wiki/contract";
import { listAnalysisReceipts, safeReceiptNodeId, writeAnalysisReceipt } from "@okf-wiki/core";
import type {
  AttachReceiptInput,
  AttachReceiptResult,
  PersistReceiptInput,
  PersistReceiptResult,
  ReceiptListItem,
  ReceiptStore,
  ResearchChildResult,
} from "./receipt-store.js";

const SUMMARY_CAP = 4_000;
const FINDINGS_CAP = 24;
const FINDING_LEN = 500;

function findingsFromSummary(summary: string): string[] {
  const lines = summary
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length >= 3);
  const out: string[] = [];
  for (const line of lines) {
    if (out.length >= FINDINGS_CAP) break;
    out.push(line.slice(0, FINDING_LEN));
  }
  if (out.length === 0 && summary.trim()) {
    out.push(summary.trim().slice(0, FINDING_LEN));
  }
  return out;
}

function buildReceipt(input: PersistReceiptInput): AnalysisReceipt {
  return AnalysisReceiptSchema.parse({
    version: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    parentId: input.parentId,
    attempt: 1,
    status: input.status ?? "complete",
    scope: input.scope.slice(0, 2000),
    summary: input.summary.slice(0, SUMMARY_CAP),
    findings: findingsFromSummary(input.summary),
    evidence: [],
    childReceipts: input.childReceipts ?? [],
    openQuestions: input.openQuestions ?? [],
  });
}

/** Core-backed ReceiptStore for production produce phases. */
export function createCoreReceiptStore(): ReceiptStore {
  return {
    async write(input: PersistReceiptInput): Promise<PersistReceiptResult> {
      const receipt = buildReceipt(input);
      const absPath = await writeAnalysisReceipt(input.workspaceRoot, receipt);
      const relativePath = `analysis/receipts/${safeReceiptNodeId(receipt.nodeId)}.json`;
      return { receiptPath: absPath, relativePath, receipt };
    },

    async attach(
      child: ResearchChildResult,
      input: AttachReceiptInput,
    ): Promise<AttachReceiptResult> {
      const persisted = await this.write({
        workspaceRoot: input.workspaceRoot,
        runId: input.runId,
        nodeId: input.nodeId,
        parentId: input.parentId,
        scope: input.scope,
        summary: input.summary ?? child.summary,
        status: input.status,
        childReceipts: input.childReceipts,
        openQuestions: input.openQuestions,
      });
      return {
        ...child,
        summary: (input.summary ?? child.summary).slice(0, SUMMARY_CAP),
        receiptPath: persisted.relativePath,
        absoluteReceiptPath: persisted.receiptPath,
      };
    },

    async buildIndex(workspaceRoot: string, runId: string): Promise<string> {
      const list = await listAnalysisReceipts(workspaceRoot, runId);
      if (list.length === 0) {
        return "No analysis receipts found under analysis/receipts/.";
      }
      const lines: string[] = ["Receipt files (read these before writing pages):"];
      for (const item of list.slice(0, 40)) {
        const rel = `analysis/${item.relativePath}`;
        const one = item.summary.replace(/\s+/g, " ").slice(0, 160);
        lines.push(`- ${rel} [${item.status}] ${item.scope} — ${one}`);
      }
      if (list.length > 40) {
        lines.push(`… and ${list.length - 40} more`);
      }
      return lines.join("\n");
    },

    async list(workspaceRoot: string, runId: string): Promise<ReceiptListItem[]> {
      const list = await listAnalysisReceipts(workspaceRoot, runId);
      return list.map((item) => ({
        relativePath: `analysis/${item.relativePath}`,
        status: item.status as ReceiptStatus,
        scope: item.scope,
        summary: item.summary,
      }));
    },
  };
}

/** Default singleton for call sites that do not inject a store. */
export const defaultReceiptStore: ReceiptStore = createCoreReceiptStore();
