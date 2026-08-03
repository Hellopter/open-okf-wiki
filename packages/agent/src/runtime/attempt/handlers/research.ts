/**
 * research.leaf / research.domain: read-only evidence gathering Attempts.
 * Phase 2: emit full AnalysisReceiptSchema (no thin {role,summary,mode}).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AnalysisReceipt,
  AnalysisReceiptSchema,
  type PiAttemptOutcome,
  PiAttemptOutcomeSchema,
} from "@okf-wiki/contract";
import { domainResearchPrompt, leafResearchPrompt } from "../../../prompts/index.js";
import {
  type EvidenceBundle,
  formatEvidenceIndex,
  formatOperatorInputNotes,
  loadEvidenceBundle,
  loadProjectedOperatorInput,
} from "../materialize.js";
import {
  type AttemptHandlerContext,
  bounded,
  forwardScopedProgress,
  liveModel,
  metricsFromSeatRun,
  parseNodeDetail,
  seatModelId,
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
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines
    .map((line) =>
      line
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim(),
    )
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
      const raw = match[0] ?? "";
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
      const item = trimmed
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim();
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
  const domainId = detail.domainId as string;
  const question = detail.question as string;
  const scope = detail.scope as string;
  const resolved =
    runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
  const operatorNotes = formatOperatorInputNotes(await loadProjectedOperatorInput(layout));
  const sourceIds = Array.isArray(detail.sourceIds)
    ? (detail.sourceIds as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : undefined;
  const leafBase = leafResearchPrompt({
    domainId,
    question,
    scope,
    nodeId: input.node.key,
    runId: input.runId,
    ...(sourceIds && sourceIds.length > 0 ? { sourceIds } : {}),
  });
  const leafTask = operatorNotes ? `${operatorNotes}\n\n${leafBase}` : leafBase;
  const seat = { modelId: seatModelId(resolved), role: "leaf" as const };
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
    onProgress: (p) => forwardScopedProgress(ctx, p, seat),
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
    metrics: metricsFromSeatRun({
      role: "leaf",
      modelId: seatModelId(resolved),
      fromRun: result.metrics,
    }),
  });
}

export async function handleResearchDomain(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  const detail = parseNodeDetail(input);
  const domainId = detail.domainId as string;
  const scope = detail.scope as string;
  const title = detail.title as string;
  const questions = detail.questions as string[];

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
  const domainSourceIds = Array.isArray(detail.sourceIds)
    ? (detail.sourceIds as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : undefined;
  const domainBase = domainResearchPrompt({
    domainId,
    title,
    scope,
    questions,
    nodeId: input.node.key,
    runId: input.runId,
    receiptIndex,
    childReceiptSummaries: childBodies || undefined,
    ...(domainSourceIds && domainSourceIds.length > 0 ? { sourceIds: domainSourceIds } : {}),
  });
  const domainTask = operatorNotes ? `${operatorNotes}\n\n${domainBase}` : domainBase;
  const seat = { modelId: seatModelId(resolved), role: "domain" as const };
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
    onProgress: (p) => forwardScopedProgress(ctx, p, seat),
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
    scope,
    summary,
    childReceipts: childIds,
  });
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, receipt);

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
    metrics: metricsFromSeatRun({
      role: "domain",
      modelId: seatModelId(resolved),
      fromRun: result.metrics,
    }),
  });
}
