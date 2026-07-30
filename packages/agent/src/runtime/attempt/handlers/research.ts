/**
 * research.leaf / research.domain: read-only evidence gathering Attempts.
 * Phase 2: emit full AnalysisReceiptSchema (no thin {role,summary,mode}).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AnalysisReceipt,
  AnalysisReceiptSchema,
  PiAttemptOutcomeSchema,
  type PiAttemptOutcome,
} from "@okf-wiki/contract";
import { domainResearchPrompt, leafResearchPrompt } from "../../../prompts/index.js";
import {
  formatEvidenceIndex,
  formatOperatorInputNotes,
  loadEvidenceBundle,
  loadProjectedOperatorInput,
  type EvidenceBundle,
} from "../materialize.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  parseNodeDetail,
  sealTranscript,
  writeAnalysisJson,
} from "../shared.js";

const LEAF_SYSTEM =
  "You are a leaf researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.";

const DOMAIN_SYSTEM =
  "You are a domain researcher. Prefer synthesizing projected child receipts under inputs/evidence/ over re-scanning the whole source tree. Use only read tools. Do not write files. Return a concise domain evidence summary.";

/** Extract bullet/numbered findings from free-text agent summary. */
export function findingsFromSummary(summary: string): string[] {
  const text = summary.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines
    .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter((line) => line.length > 0 && line.length <= 500);
  if (bullets.length >= 2) return bullets.slice(0, 40);
  // Single-paragraph summary → one finding minimum so schema has content.
  return [text.slice(0, 500)];
}

/** Best-effort evidence paths from free text (repo: or sources/ or bare paths). */
export function evidenceFromSummary(summary: string): AnalysisReceipt["evidence"] {
  const evidence: AnalysisReceipt["evidence"] = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:sources\/[^\s)\]"'`]+|repo:[^\s)\]"'`]+|[A-Za-z0-9_./-]+\.[a-zA-Z0-9]+(?:#L\d+(?:-L\d+)?)?)/g,
  ];
  for (const re of patterns) {
    for (const match of summary.matchAll(re)) {
      let raw = match[0] ?? "";
      if (!raw || raw.length > 200) continue;
      let repositoryId = "main";
      let filePath = raw;
      const repoMatch = /^repo:([^/]+)\/(.+)$/.exec(raw);
      if (repoMatch) {
        repositoryId = repoMatch[1]!;
        filePath = repoMatch[2]!;
      } else {
        const sourcesMatch = /^sources\/([^/]+)\/(.+)$/.exec(raw);
        if (sourcesMatch) {
          repositoryId = sourcesMatch[1]!;
          filePath = sourcesMatch[2]!;
        }
      }
      // Strip line anchors for path; optional L ranges.
      let startLine: number | undefined;
      let endLine: number | undefined;
      const lineMatch = /^(.*?)(?:#L(\d+)(?:-L(\d+))?)$/.exec(filePath);
      if (lineMatch) {
        filePath = lineMatch[1]!;
        startLine = Number(lineMatch[2]);
        endLine = lineMatch[3] ? Number(lineMatch[3]) : startLine;
      }
      filePath = filePath.replace(/[.,;:]+$/, "");
      if (!filePath || filePath.length < 2) continue;
      const key = `${repositoryId}:${filePath}:${startLine ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        repositoryId,
        path: filePath.slice(0, 200),
        ...(startLine !== undefined && Number.isFinite(startLine) ? { startLine } : {}),
        ...(endLine !== undefined && Number.isFinite(endLine) ? { endLine } : {}),
      });
      if (evidence.length >= 30) return evidence;
    }
  }
  return evidence;
}

function openQuestionsFromSummary(summary: string): string[] {
  const lines = summary.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^open questions/i.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{1,3}\s|^[A-Z][a-z]+ findings/i.test(trimmed)) break;
      const item = trimmed.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
      if (item) out.push(item.slice(0, 500));
    }
  }
  return out.slice(0, 20);
}

function childReceiptIds(bundle: EvidenceBundle | undefined): string[] {
  if (!bundle) return [];
  return bundle.receipts.map((r) => r.nodeId).filter(Boolean);
}

function buildAnalysisReceipt(parts: {
  runId: string;
  nodeId: string;
  parentId: string | null;
  attempt: number;
  status: AnalysisReceipt["status"];
  scope: string;
  summary: string;
  childReceipts?: string[];
}): AnalysisReceipt {
  const summary = parts.summary.slice(0, 4_000);
  return AnalysisReceiptSchema.parse({
    version: 1,
    runId: parts.runId,
    nodeId: parts.nodeId,
    parentId: parts.parentId,
    attempt: parts.attempt,
    status: parts.status,
    scope: parts.scope.slice(0, 2_000),
    summary,
    findings: findingsFromSummary(summary),
    evidence: evidenceFromSummary(summary),
    childReceipts: parts.childReceipts ?? [],
    openQuestions: openQuestionsFromSummary(summary),
  });
}

export async function handleResearchLeaf(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  const detail = parseNodeDetail(input);
  const domainId = String(detail.domainId ?? "core");
  const question = String(detail.question ?? input.node.key);
  const scope = String(detail.scope ?? "");
  const resolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
  const operatorNotes = formatOperatorInputNotes(await loadProjectedOperatorInput(layout));
  const leafBase = leafResearchPrompt({
    domainId,
    question,
    scope,
    nodeId: input.node.key,
    runId: input.runId,
  });
  const leafTask = operatorNotes ? `${operatorNotes}\n\n${leafBase}` : leafBase;
  const result = await runtime.runAgent({
    role: "leaf",
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    runWorkDir: input.workDir,
    task: leafTask,
    systemPrompt: LEAF_SYSTEM,
    preferFinalMessage: false,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    sourceIgnores: ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    transcriptPath: input.sessionPath,
  });
  if (result.failed) throw new Error(result.summary);

  const receipt = buildAnalysisReceipt({
    runId: input.runId,
    nodeId: input.node.key,
    parentId: `research.domain.${domainId}`,
    attempt: Math.max(1, input.node.generation + 1),
    status: "complete",
    scope: scope || domainId,
    summary: result.summary || `Leaf research for: ${question}`,
  });
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, receipt);
  const receiptBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");

  const transcript = await sealTranscript(input, {
    task: leafTask,
    items: result.items,
    summary: result.summary,
    terminal: "done",
    meta: { mode: result.mode, role: "leaf", receiptNodeId: receipt.nodeId },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "research", sourcePath: receiptPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(result.summary),
    // Phase 7: receipt size for economy dashboards (AttemptMetrics.extra).
    metrics: {
      role: "leaf",
      extra: {
        receiptBytes,
        sourceReadPaths: evidenceFromSummary(result.summary || "").map(
          (e) => `${e.repositoryId}:${e.path}`,
        ),
      },
    },
  });
}

export async function handleResearchDomain(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  const detail = parseNodeDetail(input);
  const domainId = String(
    detail.domainId ?? input.node.key.replace(/^research\.domain\./, ""),
  );
  const scope = String(detail.scope ?? "");
  const title = String(detail.title ?? domainId);
  const questions = Array.isArray(detail.questions) ? detail.questions.map(String) : [];

  // Phase 2: load projected child receipts (cognitive locality).
  const evidence = await loadEvidenceBundle(layout);
  const receiptIndex = formatEvidenceIndex(evidence);
  const childIds = childReceiptIds(evidence);
  const operatorNotes = formatOperatorInputNotes(await loadProjectedOperatorInput(layout));

  // Optionally inline short child summaries for the prompt (bounded).
  let childBodies = "";
  if (evidence && evidence.receipts.length > 0) {
    const snippets: string[] = [];
    for (const entry of evidence.receipts.slice(0, 12)) {
      try {
        const abs = path.join(layout.runWorkDir, entry.path);
        const raw = await readFile(abs, "utf8");
        const parsed = AnalysisReceiptSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          snippets.push(
            `### ${parsed.data.nodeId}\n${parsed.data.summary.slice(0, 800)}\nFindings:\n${parsed.data.findings
              .slice(0, 8)
              .map((f) => `- ${f}`)
              .join("\n")}`,
          );
        } else {
          snippets.push(`### ${entry.nodeId}\n${entry.summary.slice(0, 800)}`);
        }
      } catch {
        snippets.push(`### ${entry.nodeId}\n${entry.summary.slice(0, 400)}`);
      }
    }
    childBodies = snippets.join("\n\n");
  }

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
  const domainBase = domainResearchPrompt({
    domainId,
    title,
    scope,
    questions,
    nodeId: input.node.key,
    runId: input.runId,
    receiptIndex,
    childReceiptSummaries: childBodies || undefined,
  });
  const domainTask = operatorNotes ? `${operatorNotes}\n\n${domainBase}` : domainBase;
  const result = await runtime.runAgent({
    role: "domain",
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    runWorkDir: input.workDir,
    task: domainTask,
    systemPrompt: DOMAIN_SYSTEM,
    preferFinalMessage: false,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    sourceIgnores: ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    transcriptPath: input.sessionPath,
  });
  if (result.failed) throw new Error(result.summary);

  // Prefer synthesizing from children: if agent summary is thin but children exist, merge.
  let summary = result.summary?.trim() || "";
  if ((!summary || summary.length < 40) && evidence && evidence.receipts.length > 0) {
    summary = [
      `Domain ${title} synthesis from ${evidence.receipts.length} child receipt(s):`,
      ...evidence.receipts.map(
        (r) => `- ${r.nodeId}: ${r.summary || `(${r.findingsCount} findings)`}`,
      ),
    ].join("\n");
  }
  if (!summary) summary = `Domain research for ${title}`;

  const receipt = buildAnalysisReceipt({
    runId: input.runId,
    nodeId: input.node.key,
    parentId: null,
    attempt: Math.max(1, input.node.generation + 1),
    status: childIds.length > 0 ? "complete" : "partial",
    scope: scope || domainId,
    summary,
    childReceipts: childIds,
  });
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, receipt);
  const receiptBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");

  const transcript = await sealTranscript(input, {
    task: domainTask,
    items: result.items,
    summary: result.summary,
    terminal: "done",
    meta: {
      mode: result.mode,
      role: "domain",
      receiptNodeId: receipt.nodeId,
      childReceipts: childIds,
    },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "research", sourcePath: receiptPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(result.summary || summary),
    metrics: {
      role: "domain",
      extra: {
        receiptBytes,
        sourceReadPaths: evidenceFromSummary(summary).map((e) => `${e.repositoryId}:${e.path}`),
      },
    },
  });
}
