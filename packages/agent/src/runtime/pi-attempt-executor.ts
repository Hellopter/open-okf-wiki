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

export type PiAttemptExecutor = (
  input: PiAttemptInput,
  signal: AbortSignal,
) => Promise<PiAttemptOutcome>;

function bounded(text: unknown): string {
  const value = String(text ?? "Pi attempt failed")
    .replace(/\s+/g, " ")
    .trim();
  return (value || "Pi attempt failed").slice(0, 4_000);
}

function failure(error: unknown, signal: AbortSignal): PiAttemptOutcome {
  const message = bounded(error instanceof Error ? error.message : error);
  const lower = message.toLowerCase();
  const failureClass =
    signal.aborted || (error instanceof Error && error.name === "AbortError")
      ? "cancelled"
      : /rate limit|too many requests|capacity|overloaded|temporar(?:y|ily) unavailable/.test(lower)
        ? "capacity"
        : /budget|quota|credit|token limit|context length|max tokens/.test(lower)
          ? "budget"
          : /provider|model|credential|api key|authentication|unauthori[sz]ed|forbidden/.test(lower)
            ? "provider"
            : "infrastructure";
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

async function writeTranscript(
  input: PiAttemptInput,
  data: Record<string, unknown>,
): Promise<string> {
  if (!isPathInside(input.attemptDir, input.sessionPath))
    throw new Error("session path escaped attempt");
  await mkdir(path.dirname(input.sessionPath), { recursive: true });
  await writeFile(input.sessionPath, `${JSON.stringify(data)}\n`, "utf8");
  return input.sessionPath;
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

function parseNodeDetail(input: PiAttemptInput): Record<string, unknown> {
  // Detail is not on PiAttemptInput; infer from node key conventions.
  if (input.node.kind === "research.leaf") {
    const match = /^research\.leaf\.([^.]+)\.(\d+)$/.exec(input.node.key);
    if (match) {
      return {
        domainId: match[1],
        questionIndex: Number(match[2]),
        question: `Question ${match[2]}`,
      };
    }
  }
  if (input.node.kind === "research.domain") {
    const domainId = input.node.key.replace(/^research\.domain\./, "");
    return { domainId, title: domainId, scope: domainId, questions: [] as string[] };
  }
  if (input.node.kind === "review.seat") {
    const lens = input.node.key.replace(/^review\.seat\./, "") as ReviewLens;
    return { lens };
  }
  return {};
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
        const transcript = await writeTranscript(input, {
          schema: 1,
          node: input.node.key,
          attemptId: input.attemptId,
          mode: "freeze_noop",
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
        const planned = await planWikiSpec({
          layout,
          workspaceName: input.workspace.name,
          wikiLanguage: input.workspace.wikiLanguage,
          runtime,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          sourceIgnores: ignores,
          abortSignal: signal,
          customTools: [createSubmitWikiRunSpecTool({ runWorkDir: input.workDir })],
        });
        const specPath = path.join(layout.analysisDir, "spec.json");
        await writeFile(specPath, `${JSON.stringify(planned.spec, null, 2)}\n`, "utf8");
        const transcript = await writeTranscript(input, {
          schema: 1,
          node: input.node.key,
          attemptId: input.attemptId,
          mode: planned.mode,
          summary: planned.rawSummary ?? planned.spec.summary,
        });
        return PiAttemptOutcomeSchema.parse({
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "spec", role: "spec", sourcePath: specPath, directory: false },
            { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
          ],
          summary: bounded(planned.rawSummary ?? planned.spec.summary),
        });
      }

      if (input.node.kind === "write.root" && input.node.key === "write.root") {
        const spec = await readSpec(input);
        const specPath = path.join(layout.analysisDir, "spec.json");
        await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
        const resolved =
          runtime.kind === "live" ? await liveModel(input, "writer", resolveModel) : undefined;
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
          task: rootWritePrompt({
            layout,
            spec,
            wikiLanguage: input.workspace.wikiLanguage,
            multiSource: Object.keys(input.sourcePaths).length > 1,
          }),
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
        });
        await materializeWikiIndexes(layout.wikiDir);
        const transcript = await writeTranscript(input, {
          schema: 1,
          node: input.node.key,
          attemptId: input.attemptId,
          mode: produced.mode,
          summary: produced.summary,
          pages: produced.pages,
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
        const result = await runtime.runAgent({
          role: "leaf",
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          runWorkDir: input.workDir,
          task: leafResearchPrompt({
            domainId,
            question,
            scope: String(detail.scope ?? ""),
            nodeId: input.node.key,
            runId: input.runId,
          }),
          systemPrompt:
            "You are a leaf researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.",
          preferFinalMessage: false,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          sourceIgnores: ignores,
          abortSignal: signal,
          timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
        });
        if (result.failed) throw new Error(result.summary);
        const receiptPath = path.join(layout.analysisDir, `${input.node.key}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify({ role: "leaf", summary: result.summary, mode: result.mode }, null, 2)}\n`,
          "utf8",
        );
        const transcript = await writeTranscript(input, {
          schema: 1,
          node: input.node.key,
          attemptId: input.attemptId,
          mode: result.mode,
          summary: result.summary,
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
        const result = await runtime.runAgent({
          role: "domain",
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          runWorkDir: input.workDir,
          task: domainResearchPrompt({
            domainId,
            title: String(detail.title ?? domainId),
            scope: String(detail.scope ?? ""),
            questions: Array.isArray(detail.questions) ? detail.questions.map(String) : [],
            nodeId: input.node.key,
            runId: input.runId,
          }),
          systemPrompt:
            "You are a domain researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.",
          preferFinalMessage: false,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          sourceIgnores: ignores,
          abortSignal: signal,
          timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
        });
        if (result.failed) throw new Error(result.summary);
        const receiptPath = path.join(layout.analysisDir, `${input.node.key}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify({ role: "domain", summary: result.summary, mode: result.mode }, null, 2)}\n`,
          "utf8",
        );
        const transcript = await writeTranscript(input, {
          schema: 1,
          node: input.node.key,
          attemptId: input.attemptId,
          mode: result.mode,
          summary: result.summary,
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
        const result = await runtime.runAgent({
          role: "reviewer",
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          runWorkDir: input.workDir,
          task: reviewerPrompt({ pages, lens }),
          systemPrompt:
            "You are a wiki reviewer. Return JSON with clean/defects/summary. Prefer fail-closed blocking only for true defects.",
          preferFinalMessage: true,
          model: resolved?.model,
          modelRuntime: resolved?.modelRuntime,
          maxContextTokens: resolved?.model.contextWindow,
          contextTargetTokens: input.workspace.limits.contextTargetTokens,
          sourceIgnores: ignores,
          abortSignal: signal,
          timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
          additionalSkillPaths: [layout.skillDir],
        });
        if (result.failed) throw new Error(result.summary);
        const receiptPath = path.join(layout.analysisDir, `${input.node.key}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify({ lens, summary: result.summary, mode: result.mode }, null, 2)}\n`,
          "utf8",
        );
        const transcript = await writeTranscript(input, {
          schema: 1,
          node: input.node.key,
          attemptId: input.attemptId,
          lens,
          mode: result.mode,
          summary: result.summary,
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
          task: [
            rootWritePrompt({
              layout,
              spec,
              wikiLanguage: input.workspace.wikiLanguage,
              multiSource: Object.keys(input.sourcePaths).length > 1,
            }),
            "",
            "Repair mode: fix blocking defects on the existing Staging Wiki; preserve good pages.",
          ].join("\n"),
          spanId: input.attemptId,
          nodeKey: input.node.key,
          runIndex: input.node.runIndex,
          graphRole: "repair",
        });
        await materializeWikiIndexes(layout.wikiDir);
        const transcript = await writeTranscript(input, {
          schema: 1,
          node: input.node.key,
          attemptId: input.attemptId,
          mode: produced.mode,
          summary: produced.summary,
          pages: produced.pages,
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
      // even when the attempt fails or is cancelled. Never mask the original failure.
      if (input && outcome.type === "failed") {
        try {
          await writeTranscript(input, {
            schema: 1,
            node: input.node.key,
            attemptId: input.attemptId,
            mode: "failed",
            failureClass: outcome.failureClass,
            error: outcome.error,
            summary: outcome.error,
          });
        } catch {
          // ignore transcript write errors on the failure path
        }
      }
      return outcome;
    }
  };
}
