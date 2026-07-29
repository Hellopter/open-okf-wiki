/**
 * Pi boundary for one disposable WikiRuns attempt.
 *
 * This module owns only Pi-local materialisation and execution.  WikiRuns owns
 * claiming, sealing, gates, and publication; keeping those out of this adapter
 * makes an interrupted Pi session safe to discard.
 */

import { chmod, cp, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttemptItem,
  type PiAttemptExecutor,
  type PiAttemptFailureClass,
  type PiAttemptInput,
  PiAttemptInputSchema,
  type PiAttemptOutcome,
  PiAttemptOutcomeSchema,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import { effectiveIgnoresForSource, isPathInside } from "@okf-wiki/core";
import type { AgentRunner } from "../ports/agent-runner.js";
import { listWikiMarkdown, materializeWikiIndexes } from "../produce/wiki-pages.js";
import {
  domainResearchPrompt,
  leafResearchPrompt,
  type ReviewLens,
  reviewerPrompt,
  rootWritePrompt,
  rootWriteSystemPrompt,
} from "../prompts/index.js";
import { createSubmitWikiRunSpecTool } from "../tools/submit-wiki-run-spec.js";
import { planWikiSpec } from "../workflow/phases/plan-phase.js";
import { finalizeAttemptTranscript } from "./attempt-transcript-sink.js";
import { createFixtureProduceRuntime } from "./fixture-runner.js";
import { resolveWorkspacePiModel } from "./model/provider-model.js";
import { resolveModelSelection } from "./model/role-model.js";
import { createLiveProduceRuntime } from "./scoped-runner.js";
import { runWorkdirLayout } from "./workdir.js";

type ResolvePiModel = typeof resolveWorkspacePiModel;

export type CreatePiAttemptExecutorOptions = {
  /** Explicit offline path for tests and local fixture runs. */
  fixture?: boolean;
  /** Inject the runner for focused tests; production uses Pi's live runtime. */
  runtime?: AgentRunner;
  /** Inject provider resolution without exposing credentials through the attempt contract. */
  resolveModel?: ResolvePiModel;
};

export type { PiAttemptExecutor };

function bounded(text: unknown): string {
  const value = String(text ?? "Pi attempt failed")
    .replace(/\s+/g, " ")
    .trim();
  return (value || "Pi attempt failed").slice(0, 4_000);
}

/**
 * Map a thrown value to PiAttemptFailureClass.
 * Prefer structured errorClass / named errors; message patterns are fallback.
 * Capacity (overflow / compact exhausted) must never look like transport.
 * Transport (429/5xx/overload/network) maps to infrastructure — L0 already
 * retried in-session; L_control may requeue research once for infrastructure.
 */
function classifyPiFailureClass(error: unknown, signal: AbortSignal): PiAttemptFailureClass {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return "cancelled";
  }

  // Structured classes from run-scoped-agent (CapacityError / BudgetError / …).
  if (error && typeof error === "object" && "errorClass" in error) {
    const cls = (error as { errorClass?: unknown }).errorClass;
    if (cls === "capacity") return "capacity";
    if (cls === "budget") return "budget";
    if (cls === "infrastructure") return "infrastructure";
    // ErrorClass "transient" has no PiAttemptOutcome twin — infrastructure is the
    // control-plane equivalent after L0 transport exhaustion.
    if (cls === "transient") return "infrastructure";
    if (cls === "policy") return "budget";
  }
  if (error instanceof Error) {
    if (error.name === "CapacityError") return "capacity";
    if (error.name === "BudgetError") return "budget";
    if (error.name === "InfrastructureError") return "infrastructure";
  }

  const message = bounded(error instanceof Error ? error.message : error);
  const lower = message.toLowerCase();

  // Capacity first — context overflow / compact exhausted (not transport).
  if (
    /context overflow|context.?length|maximum context|prompt is too long|context_length|too many tokens|token limit exceeded|input is too long|compact-and-retry|exceeds capacity gate|\bcapacity\b/i.test(
      lower,
    )
  ) {
    return "capacity";
  }
  // Budget / wall-clock / quota (policy-ish billing folded to budget for Pi enum).
  if (
    /budget exhausted|token budget|timed out after \d+|workspace request timeout|insufficient_quota|quota exceeded|billing|out of (?:budget|credits?)|\bcredits?\b/i.test(
      lower,
    )
  ) {
    return "budget";
  }
  // Transport / overload → infrastructure (L_control may auto-requeue research).
  if (
    /rate.?limit|too many requests|\b(?:429|500|502|503|529)\b|overloaded|temporar(?:y|ily) unavailable|service unavailable|bad gateway|internal server error|econnreset|etimedout|econnrefused|eai_again|enotfound|epipe|socket hang up|fetch failed|network error|connection (?:closed|reset|refused|error)/i.test(
      lower,
    )
  ) {
    return "infrastructure";
  }
  // Stable provider / auth failures.
  if (
    /credential|api key|authentication|unauthori[sz]ed|forbidden|invalid.?api|model not found/i.test(
      lower,
    )
  ) {
    return "provider";
  }
  return "infrastructure";
}

function failure(error: unknown, signal: AbortSignal): PiAttemptOutcome {
  const message = bounded(error instanceof Error ? error.message : error);
  const failureClass = classifyPiFailureClass(error, signal);
  return PiAttemptOutcomeSchema.parse({ type: "failed", error: message, failureClass });
}

function assertAttemptPaths(input: PiAttemptInput): void {
  if (!isPathInside(input.attemptDir, input.workDir)) {
    throw new Error("attempt workDir must be inside attemptDir");
  }
  if (!isPathInside(input.attemptDir, input.sessionPath)) {
    throw new Error("attempt sessionPath must be inside attemptDir");
  }
}

function assertSealedSource(input: PiAttemptInput, sourcePath: string): void {
  if (
    !input.sealedInputs.some(
      (item) =>
        item.artifact.kind === "snapshot_set" && isPathInside(item.readOnlyPath, sourcePath),
    )
  ) {
    throw new Error(`source input is not under a sealed snapshot artifact: ${sourcePath}`);
  }
}

function assertSealedSkill(input: PiAttemptInput): void {
  if (
    !input.sealedInputs.some(
      (item) => item.artifact.kind === "skill" && isPathInside(item.readOnlyPath, input.skillPath),
    )
  ) {
    throw new Error("skill input is not under a sealed skill artifact");
  }
}

async function assertOrdinaryTree(directory: string, label: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(`${label} contains a non-ordinary filesystem entry: ${child}`);
    }
    if (info.isDirectory()) await assertOrdinaryTree(child, label);
  }
}

async function makeTreeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(child);
    else await chmod(child, 0o444);
  }
  await chmod(directory, 0o555);
}

async function copyReadOnlyTree(from: string, to: string, label: string): Promise<void> {
  if (!(await stat(from)).isDirectory()) throw new Error(`${label} must be a directory`);
  await assertOrdinaryTree(from, label);
  await cp(from, to, { recursive: true, dereference: false, errorOnExist: true });
  await assertOrdinaryTree(to, label);
  await makeTreeReadOnly(to);
}

async function materializeInputs(input: PiAttemptInput) {
  assertAttemptPaths(input);
  await mkdir(input.workDir, { recursive: true });
  const sourceMounts = new Map<string, string>();
  for (const [sourceId, sourcePath] of Object.entries(input.sourcePaths)) {
    assertSealedSource(input, sourcePath);
    const mount = path.join(input.workDir, "sources", sourceId);
    await mkdir(path.dirname(mount), { recursive: true });
    await copyReadOnlyTree(sourcePath, mount, `sealed source ${sourceId}`);
    sourceMounts.set(sourceId, mount);
  }
  assertSealedSkill(input);
  await copyReadOnlyTree(input.skillPath, path.join(input.workDir, "skill"), "sealed skill");
  await mkdir(path.join(input.workDir, "wiki"), { recursive: true });
  await mkdir(path.join(input.workDir, "analysis"), { recursive: true });
  return runWorkdirLayout(input.workDir, sourceMounts);
}

function sourceIgnores(input: PiAttemptInput): Map<string, readonly string[]> {
  return new Map(
    input.workspace.sources.map((source) => [source.id, effectiveIgnoresForSource(source)]),
  );
}

/**
 * Seal a conversation-shaped attempt transcript (JSONL).
 * Prefer items/summary from the scoped agent; never metadata-only when content exists.
 * Live runs may already have written sessionPath via transcriptPath — finalize replaces
 * with a complete snapshot including optional control meta.
 */
async function sealTranscript(
  input: PiAttemptInput,
  parts: {
    task?: string;
    items?: AttemptItem[];
    summary?: string;
    terminal?: "done" | "error" | "cancelled";
    meta?: Record<string, unknown>;
  },
): Promise<string> {
  if (!isPathInside(input.attemptDir, input.sessionPath))
    throw new Error("session path escaped attempt");
  return finalizeAttemptTranscript(input.sessionPath, {
    task: parts.task,
    items: parts.items,
    summary: parts.summary,
    terminal: parts.terminal ?? "done",
    meta: {
      node: input.node.key,
      attemptId: input.attemptId,
      ...parts.meta,
    },
  });
}

async function readSpec(input: PiAttemptInput) {
  const specInput = input.sealedInputs.find((item) => item.role === "spec");
  if (!specInput) throw new Error("write.root requires a sealed spec input");
  const candidates = [
    specInput.readOnlyPath,
    path.join(specInput.readOnlyPath, "spec.json"),
    path.join(specInput.readOnlyPath, "analysis", "spec.json"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return WikiRunSpecSchema.parse(JSON.parse(await readFile(candidate, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`sealed spec is unreadable: ${bounded(error)}`);
    }
  }
  throw new Error("sealed spec artifact does not contain spec.json");
}

async function liveModel(
  input: PiAttemptInput,
  role: "planner" | "writer" | "worker" | "reviewer",
  resolveModel: ResolvePiModel,
) {
  const selected = resolveModelSelection({ workspace: input.workspace, role });
  return resolveModel({ profileId: selected.profileId, modelId: selected.id });
}

async function readSealedWikiTree(input: PiAttemptInput, destWikiDir: string): Promise<void> {
  const wikiInput = input.sealedInputs.find((item) => item.role === "wiki_tree");
  if (!wikiInput) throw new Error(`${input.node.kind} requires a sealed wiki_tree input`);
  await mkdir(path.dirname(destWikiDir), { recursive: true });
  await cp(wikiInput.readOnlyPath, destWikiDir, { recursive: true, dereference: false });
}

/**
 * Prefer sealed node.detail from WikiRuns; fall back to key conventions only
 * for missing fields so older claims without detail still run.
 */
function parseNodeDetail(input: PiAttemptInput): Record<string, unknown> {
  const sealed = input.node.detail ?? {};
  if (input.node.kind === "research.leaf") {
    const match = /^research\.leaf\.([^.]+)\.(\d+)$/.exec(input.node.key);
    const domainId =
      (typeof sealed.domainId === "string" && sealed.domainId) || match?.[1] || "core";
    const questionIndex =
      typeof sealed.questionIndex === "number"
        ? sealed.questionIndex
        : match
          ? Number(match[2])
          : undefined;
    const question =
      (typeof sealed.question === "string" && sealed.question.trim()) ||
      (questionIndex != null ? `Question ${questionIndex}` : input.node.key);
    return {
      ...sealed,
      domainId,
      questionIndex,
      question,
      scope: typeof sealed.scope === "string" ? sealed.scope : "",
    };
  }
  if (input.node.kind === "research.domain") {
    const domainId =
      (typeof sealed.domainId === "string" && sealed.domainId) ||
      input.node.key.replace(/^research\.domain\./, "");
    const questions = Array.isArray(sealed.questions)
      ? sealed.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : [];
    return {
      ...sealed,
      domainId,
      title:
        (typeof sealed.title === "string" && sealed.title.trim()) || domainId,
      scope: typeof sealed.scope === "string" ? sealed.scope : "",
      questions,
    };
  }
  if (input.node.kind === "review.seat") {
    const fromKey = input.node.key.replace(/^review\.seat\./, "");
    const lens =
      (typeof sealed.lens === "string" && sealed.lens.trim()) || fromKey || "general";
    return { ...sealed, lens };
  }
  return { ...sealed };
}

/**
 * Create the concrete Pi executor used by WikiRuns.  It does not read or write
 * WikiRuns state; all returned files remain unsealed Attempt output.
 */
export function createPiAttemptExecutor(
  options: CreatePiAttemptExecutorOptions = {},
): PiAttemptExecutor {
  const runtime =
    options.runtime ??
    (options.fixture ? createFixtureProduceRuntime() : createLiveProduceRuntime());
  const resolveModel = options.resolveModel ?? resolveWorkspacePiModel;

  return async (rawInput, signal) => {
    let input: PiAttemptInput | undefined;
    try {
      input = PiAttemptInputSchema.parse(rawInput);
      if (signal.aborted)
        throw Object.assign(new Error("Pi attempt cancelled"), { name: "AbortError" });
      const layout = await materializeInputs(input);
      const ignores = sourceIgnores(input);

      // Freeze is owned by WikiRuns (Run Boundary). The optional executor probe is a
      // no-op success so production wiring can share one PiAttemptExecutor for all nodes.
      if (input.node.kind === "freeze") {
        const transcript = await sealTranscript(input, {
          summary: "Freeze inputs already sealed by WikiRuns",
          terminal: "done",
          meta: { mode: "freeze_noop" },
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            {
              kind: "manifest",
              role: "attempt_output",
              sourcePath: input.workDir,
              directory: true,
            },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary: "Freeze inputs already sealed by WikiRuns",
        });
      }

      if (input.node.kind === "plan" && input.node.key === "plan") {
        const resolved =
          runtime.kind === "live" ? await liveModel(input, "planner", resolveModel) : undefined;
        const planTask = `Plan WikiRunSpec for ${input.workspace.name}`;
        const planned = await planWikiSpec({
          layout,
          workspaceName: input.workspace.name,
          wikiLanguage: input.workspace.wikiLanguage,
          runtime,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          retry: input.workspace.limits.retry,
          timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
          orchestration: input.workspace.orchestration,
          sourceIgnores: ignores,
          abortSignal: signal,
          customTools: [createSubmitWikiRunSpecTool({ runWorkDir: input.workDir })],
          transcriptPath: input.sessionPath,
        });
        const specPath = path.join(layout.analysisDir, "spec.json");
        await writeFile(specPath, `${JSON.stringify(planned.spec, null, 2)}\n`, "utf8");
        const summary = bounded(planned.rawSummary ?? planned.spec.summary);
        const transcript = await sealTranscript(input, {
          task: planTask,
          items: planned.items,
          summary,
          terminal: "done",
          meta: { mode: planned.mode, source: planned.source },
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "spec", role: "spec", sourcePath: specPath, directory: false },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary,
        });
      }

      if (input.node.kind === "write.root" && input.node.key === "write.root") {
        const spec = await readSpec(input);
        const specPath = path.join(layout.analysisDir, "spec.json");
        await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
        const resolved =
          runtime.kind === "live" ? await liveModel(input, "writer", resolveModel) : undefined;
        const writeTask = rootWritePrompt({
          layout,
          spec,
          wikiLanguage: input.workspace.wikiLanguage,
          multiSource: Object.keys(input.sourcePaths).length > 1,
        });
        const produced = await runtime.writeWiki({
          layout,
          spec,
          workspaceName: input.workspace.name,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          retry: input.workspace.limits.retry,
          additionalSkillPaths: [layout.skillDir],
          sourceIgnores: ignores,
          abortSignal: signal,
          timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
          systemPrompt: rootWriteSystemPrompt(),
          task: writeTask,
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          transcriptPath: input.sessionPath,
        });
        await materializeWikiIndexes(layout.wikiDir);
        const transcript = await sealTranscript(input, {
          task: writeTask,
          items: produced.items,
          summary: produced.summary,
          terminal: "done",
          meta: { mode: produced.mode, pages: produced.pages },
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "wiki_tree", role: "wiki_tree", sourcePath: layout.wikiDir, directory: true },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary: bounded(produced.summary),
        });
      }

      if (input.node.kind === "research.leaf") {
        const detail = parseNodeDetail(input);
        const domainId = String(detail.domainId ?? "core");
        const question = String(detail.question ?? input.node.key);
        const resolved =
          runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
        const leafTask = leafResearchPrompt({
          domainId,
          question,
          scope: String(detail.scope ?? ""),
          nodeId: input.node.key,
          runId: input.runId,
        });
        const result = await runtime.runAgent({
          role: "leaf",
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          runWorkDir: input.workDir,
          task: leafTask,
          systemPrompt:
            "You are a leaf researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.",
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
        const receiptPath = path.join(layout.analysisDir, `${input.node.key}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify({ role: "leaf", summary: result.summary, mode: result.mode }, null, 2)}\n`,
          "utf8",
        );
        const transcript = await sealTranscript(input, {
          task: leafTask,
          items: result.items,
          summary: result.summary,
          terminal: "done",
          meta: { mode: result.mode, role: "leaf" },
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "receipt", role: "research", sourcePath: receiptPath, directory: false },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary: bounded(result.summary),
        });
      }

      if (input.node.kind === "research.domain") {
        const detail = parseNodeDetail(input);
        const domainId = String(
          detail.domainId ?? input.node.key.replace(/^research\.domain\./, ""),
        );
        const resolved =
          runtime.kind === "live" ? await liveModel(input, "worker", resolveModel) : undefined;
        const domainTask = domainResearchPrompt({
          domainId,
          title: String(detail.title ?? domainId),
          scope: String(detail.scope ?? ""),
          questions: Array.isArray(detail.questions) ? detail.questions.map(String) : [],
          nodeId: input.node.key,
          runId: input.runId,
        });
        const result = await runtime.runAgent({
          role: "domain",
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          runWorkDir: input.workDir,
          task: domainTask,
          systemPrompt:
            "You are a domain researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.",
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
        const receiptPath = path.join(layout.analysisDir, `${input.node.key}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify({ role: "domain", summary: result.summary, mode: result.mode }, null, 2)}\n`,
          "utf8",
        );
        const transcript = await sealTranscript(input, {
          task: domainTask,
          items: result.items,
          summary: result.summary,
          terminal: "done",
          meta: { mode: result.mode, role: "domain" },
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "receipt", role: "research", sourcePath: receiptPath, directory: false },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary: bounded(result.summary),
        });
      }

      if (input.node.kind === "review.seat") {
        await readSealedWikiTree(input, layout.wikiDir);
        const detail = parseNodeDetail(input);
        const lens = (String(detail.lens ?? "general") as ReviewLens) || "general";
        const pages = await listWikiMarkdown(layout.wikiDir);
        const resolved =
          runtime.kind === "live" ? await liveModel(input, "reviewer", resolveModel) : undefined;
        const reviewTask = reviewerPrompt({ pages, lens });
        const result = await runtime.runAgent({
          role: "reviewer",
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          runWorkDir: input.workDir,
          task: reviewTask,
          systemPrompt:
            "You are a wiki reviewer. Return JSON with clean/defects/summary. Prefer fail-closed blocking only for true defects.",
          preferFinalMessage: true,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          retry: input.workspace.limits.retry,
          sourceIgnores: ignores,
          abortSignal: signal,
          timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
          additionalSkillPaths: [layout.skillDir],
          transcriptPath: input.sessionPath,
        });
        if (result.failed) throw new Error(result.summary);
        const receiptPath = path.join(layout.analysisDir, `${input.node.key}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify({ lens, summary: result.summary, mode: result.mode }, null, 2)}\n`,
          "utf8",
        );
        const transcript = await sealTranscript(input, {
          task: reviewTask,
          items: result.items,
          summary: result.summary,
          terminal: "done",
          meta: { mode: result.mode, lens },
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "receipt", role: "review_seat", sourcePath: receiptPath, directory: false },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary: bounded(result.summary),
        });
      }

      if (input.node.kind === "repair") {
        await readSealedWikiTree(input, layout.wikiDir);
        const spec = await readSpec(input);
        const specPath = path.join(layout.analysisDir, "spec.json");
        await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
        const resolved =
          runtime.kind === "live" ? await liveModel(input, "writer", resolveModel) : undefined;
        const repairFeedback =
          typeof input.node.detail?.feedback === "string" && input.node.detail.feedback.trim()
            ? input.node.detail.feedback.trim()
            : undefined;
        // Feedback first so it is not lost when transcripts truncate long write prompts.
        const repairTask = [
          ...(repairFeedback ? [`Operator feedback: ${repairFeedback}`, ""] : []),
          rootWritePrompt({
            layout,
            spec,
            wikiLanguage: input.workspace.wikiLanguage,
            multiSource: Object.keys(input.sourcePaths).length > 1,
          }),
          "",
          "Repair mode: fix blocking defects on the existing Staging Wiki; preserve good pages.",
        ].join("\n");
        const produced = await runtime.writeWiki({
          layout,
          spec,
          workspaceName: input.workspace.name,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          retry: input.workspace.limits.retry,
          additionalSkillPaths: [layout.skillDir],
          sourceIgnores: ignores,
          abortSignal: signal,
          timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
          systemPrompt: rootWriteSystemPrompt(),
          task: repairTask,
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          graphRole: "repair",
          transcriptPath: input.sessionPath,
        });
        await materializeWikiIndexes(layout.wikiDir);
        const transcript = await sealTranscript(input, {
          task: repairTask,
          items: produced.items,
          summary: produced.summary,
          terminal: "done",
          meta: { mode: produced.mode, pages: produced.pages },
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "wiki_tree", role: "wiki_tree", sourcePath: layout.wikiDir, directory: true },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary: bounded(produced.summary),
        });
      }

      throw new Error(`unsupported Pi attempt node: ${input.node.kind}/${input.node.key}`);
    } catch (error) {
      const outcome = failure(error, signal);
      // Best-effort: leave a readable session transcript for the transcript API
      // even when the attempt fails or is cancelled. Prefer appending over wipe
      // when live JSONL already exists — sealTranscript rebuilds from summary.
      if (input && outcome.type === "failed") {
        try {
          if (!isPathInside(input.attemptDir, input.sessionPath)) {
            throw new Error("session path escaped attempt");
          }
          // Preserve any live JSONL already written by the scoped agent sink.
          await finalizeAttemptTranscript(input.sessionPath, {
            summary: outcome.error,
            terminal: outcome.failureClass === "cancelled" ? "cancelled" : "error",
            preserveExisting: true,
            meta: {
              node: input.node.key,
              attemptId: input.attemptId,
              mode: "failed",
              failureClass: outcome.failureClass,
              error: outcome.error,
            },
          });
        } catch {
          // ignore transcript write errors on the failure path
        }
      }
      return outcome;
    }
  };
}
