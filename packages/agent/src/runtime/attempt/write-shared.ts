/**
 * Shared write path for write.root and repair.
 *
 * Eliminates near-duplicate branches: both materialise a sealed spec, optionally
 * seed a prior wiki tree, build a feedback-first task, call writeWiki, index pages,
 * and seal a transcript with wiki_tree + transcript artifacts.
 *
 * Phase 2: consume projected EvidenceBundle, defects, and refresh prior wiki.
 */

import {
  PiAttemptOutcomeSchema,
  type PiAttemptOutcome,
  type RepairRequest,
  RepairRequestSchema,
} from "@okf-wiki/contract";
import { digestPublicationTreeContentOnly } from "@okf-wiki/core";
import { materializeWikiIndexes } from "../../produce/wiki-pages.js";
import { rootWritePrompt, rootWriteSystemPrompt } from "../../prompts/index.js";
import {
  formatEvidenceIndex,
  formatOperatorInputNotes,
  loadEvidenceBundle,
  loadProjectedDefectsText,
  loadProjectedIntent,
  loadProjectedOperatorInput,
} from "./materialize.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  readSealedWikiTree,
  readSpec,
  sealTranscript,
  writeAnalysisJson,
} from "./shared.js";

export type WriteSharedMode = "write.root" | "repair";

/** Parse optional structured RepairRequest from node detail (schema-validated). */
function loadRepairRequest(detail: AttemptHandlerContext["input"]["node"]["detail"]): RepairRequest | undefined {
  const raw = detail && "repairRequest" in detail ? detail.repairRequest : undefined;
  if (raw == null) return undefined;
  const parsed = RepairRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Lead-in block so truncation still keeps repair scope facts. */
function formatRepairRequestBlock(request: RepairRequest): string {
  const lines: string[] = [
    "RepairRequest:",
    "```json",
    JSON.stringify(request, null, 2),
    "```",
  ];
  if (request.scope.pages.length > 0) {
    lines.push(`Repair scope pages: ${request.scope.pages.join(", ")}`);
  }
  lines.push(`Baseline candidate: ${request.baselineCandidateId}`);
  if (request.scope.pages.length > 0) {
    lines.push(
      "Only edit the listed scope pages unless a consistency fix on another page is strictly required.",
    );
  }
  return lines.join("\n");
}

/**
 * Run the writer (or repair-style writer) for one Attempt.
 *
 * Behaviour differences preserved:
 * - repair: always requires sealed wiki_tree; always graphRole "repair";
 *   repair instruction mentions "blocking defects".
 * - write.root: optional feedback turns the task into repair-style; prior wiki
 *   is seeded by materialize for refresh/prior_wiki; graphRole "repair"
 *   only when feedback is present; instruction mentions validation/citation/frontmatter.
 */
export async function runWriteShared(
  ctx: AttemptHandlerContext,
  mode: WriteSharedMode,
): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;

  const intent = await loadProjectedIntent(layout);
  const isRefresh = intent?.mode === "refresh";

  if (mode === "repair") {
    // materialize may already have seeded wiki/ from wiki_tree; ensure present.
    const needsSeed = input.sealedInputs.some(
      (item) => item.role === "wiki_tree" || item.role === "prior_wiki",
    );
    if (needsSeed) {
      try {
        await readSealedWikiTree(input, layout.wikiDir);
      } catch {
        // Already seeded by materialize — continue.
      }
    } else {
      await readSealedWikiTree(input, layout.wikiDir);
    }
  }

  // Refresh fail-closed: must have prior wiki projected or sealed.
  if (mode === "write.root" && isRefresh) {
    const hasPrior = input.sealedInputs.some(
      (item) => item.role === "prior_wiki" || item.role === "wiki_tree",
    );
    if (!hasPrior) {
      throw new Error(
        "write.root refresh mode requires sealed prior_wiki (or wiki_tree); freeze must pin the published wiki",
      );
    }
    // Ensure wiki/ is seeded (materialize should have done this).
    try {
      await readSealedWikiTree(input, layout.wikiDir);
    } catch {
      // Prefer prior_wiki role for seed.
      const prior = input.sealedInputs.find((item) => item.role === "prior_wiki");
      if (prior) {
        const { cp, mkdir } = await import("node:fs/promises");
        await mkdir(layout.wikiDir, { recursive: true });
        await cp(prior.readOnlyPath, layout.wikiDir, {
          recursive: true,
          dereference: false,
          errorOnExist: false,
        });
      } else {
        throw new Error("refresh mode: prior wiki could not be seeded into wiki/");
      }
    }
  }

  // write.root with feedback: seed prior wiki when sealed (best-effort).
  const feedback =
    typeof input.node.detail?.feedback === "string" && input.node.detail.feedback.trim()
      ? input.node.detail.feedback.trim()
      : undefined;
  const repairRequest = loadRepairRequest(input.node.detail);
  const repairRequestBlock = repairRequest ? formatRepairRequestBlock(repairRequest) : undefined;

  if (
    mode === "write.root" &&
    !isRefresh &&
    (feedback || repairRequest) &&
    input.sealedInputs.some((item) => item.role === "wiki_tree")
  ) {
    try {
      await readSealedWikiTree(input, layout.wikiDir);
    } catch {
      // Prior wiki may be absent or unreadable on first write; pure repair still proceeds.
    }
  }

  const spec = await readSpec(input, layout);
  await writeAnalysisJson(layout, "spec.json", spec);

  const evidence = await loadEvidenceBundle(layout);
  const receiptIndex = formatEvidenceIndex(evidence);
  const defectsText =
    (await loadProjectedDefectsText(layout)) ??
    (await loadSealedDefectsText(input));
  const operatorNotes = formatOperatorInputNotes(await loadProjectedOperatorInput(layout));

  const resolved =
    runtime.kind === "live" ? await liveModel(input, "writer", resolveModel) : undefined;

  const baseWritePrompt = rootWritePrompt({
    layout,
    spec,
    wikiLanguage: input.workspace.wikiLanguage,
    multiSource: Object.keys(input.sourcePaths).length > 1,
    receiptIndex,
    repairDefects: defectsText,
    isRefresh: isRefresh || mode === "repair",
  });

  // RepairRequest + feedback first so truncation does not drop sealed facts.
  let writeTask: string;
  let asRepair: boolean;
  if (mode === "repair") {
    asRepair = true;
    writeTask = [
      ...(repairRequestBlock ? [repairRequestBlock, ""] : []),
      ...(operatorNotes ? [operatorNotes, ""] : []),
      ...(feedback ? [`Operator feedback: ${feedback}`, ""] : []),
      baseWritePrompt,
      "",
      "Repair mode: fix blocking defects on the existing Staging Wiki; preserve good pages.",
    ].join("\n");
  } else if (feedback || repairRequest) {
    asRepair = true;
    writeTask = [
      ...(repairRequestBlock ? [repairRequestBlock, ""] : []),
      ...(operatorNotes ? [operatorNotes, ""] : []),
      ...(feedback ? [`Operator feedback: ${feedback}`, ""] : []),
      baseWritePrompt,
      "",
      "Repair mode: fix validation, citation, and frontmatter defects on the existing Staging Wiki; preserve good pages.",
    ].join("\n");
  } else {
    asRepair = false;
    writeTask = operatorNotes ? `${operatorNotes}\n\n${baseWritePrompt}` : baseWritePrompt;
  }

  // Baseline content digest for empty-repair detection (EvaluationRound invariant).
  let baselineWikiDigest: string | undefined;
  if (asRepair) {
    try {
      baselineWikiDigest = await digestPublicationTreeContentOnly(layout.wikiDir);
    } catch {
      baselineWikiDigest = undefined;
    }
  }

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
    ...(asRepair ? { graphRole: "repair" as const } : {}),
    transcriptPath: input.sessionPath,
  });

  await materializeWikiIndexes(layout.wikiDir);

  // Fail closed on no-op repair: digest unchanged means the round did not produce a new candidate.
  if (asRepair && baselineWikiDigest) {
    const afterDigest = await digestPublicationTreeContentOnly(layout.wikiDir);
    if (afterDigest === baselineWikiDigest) {
      throw new Error(
        "repair produced no content change (wiki digest unchanged); empty repair rounds are not allowed",
      );
    }
  }

  const transcript = await sealTranscript(input, {
    task: writeTask,
    items: produced.items,
    summary: produced.summary,
    terminal: "done",
    meta: {
      mode: produced.mode,
      pages: produced.pages,
      isRefresh: Boolean(isRefresh),
      evidenceReceipts: evidence?.receipts.length ?? 0,
      // write.root with feedback tagged repair:true historically; repair node omits it.
      ...(mode === "write.root" && feedback ? { repair: true } : {}),
    },
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

async function loadSealedDefectsText(
  input: AttemptHandlerContext["input"],
): Promise<string | undefined> {
  const sealed = input.sealedInputs.find((item) => item.role === "defects");
  if (!sealed) return undefined;
  const { readFile, stat } = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const candidates = [
    sealed.readOnlyPath,
    pathMod.join(sealed.readOnlyPath, "defects.json"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return await readFile(candidate, "utf8");
    } catch {
      // try next
    }
  }
  return undefined;
}
