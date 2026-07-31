/**
 * Mechanical validate.pre / validate.final execution.
 *
 * Single mechanical contract (EvaluationPolicy): critical pages, frontmatter,
 * citations when sources are bound. Host auto-fixes clamp/canonicalize before
 * score so off-by-one citation OOB does not burn model repair budget.
 */

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type EvaluationPolicy,
  evaluationPolicyFromAcceptance,
  type PiAttemptOutcome,
  type WikiRunSpec,
  WikiRunSpecAcceptanceSchema,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import { regenerateWikiIndexes, toMechanicalReport, validateWikiTree } from "@okf-wiki/core";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { type MechanicalHost, sealedInputPath } from "./host.js";

async function loadSealedSpec(
  host: MechanicalHost,
  claim: ClaimedNode,
  runDir: string,
): Promise<WikiRunSpec | undefined> {
  const specPath = sealedInputPath(host, claim, runDir, "spec");
  if (!specPath) return undefined;
  const candidates = [
    path.join(specPath, "spec.json"),
    specPath,
    path.join(specPath, "analysis", "spec.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = WikiRunSpecSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // try next
    }
  }
  return undefined;
}

function policyForSpec(spec: WikiRunSpec | undefined): EvaluationPolicy {
  const acceptance = WikiRunSpecAcceptanceSchema.parse(spec?.acceptance ?? {});
  return evaluationPolicyFromAcceptance(acceptance);
}

export async function mechanicalValidate(
  host: MechanicalHost,
  claim: ClaimedNode,
  workDir: string,
  runDir: string,
): Promise<PiAttemptOutcome> {
  const wikiPath = sealedInputPath(host, claim, runDir, "wiki_tree");
  if (!wikiPath) {
    return {
      type: "failed",
      error: "validate requires sealed wiki_tree input",
      failureClass: "infrastructure",
    };
  }
  const stagingWiki = path.join(workDir, "wiki");
  await cp(wikiPath, stagingWiki, { recursive: true, dereference: false });
  // Drop prior seal manifest so re-sealing does not digest a self-referential file.
  await rm(path.join(stagingWiki, ".okf-artifact-manifest.json"), { force: true });
  const sourcesPath = sealedInputPath(host, claim, runDir, "sources");
  const sources: Array<{ id: string; path: string }> = [];
  if (sourcesPath) {
    const pinned = host.trustedPinnedInputs(claim.runId);
    const ids =
      pinned?.sources && Array.isArray(pinned.sources)
        ? (pinned.sources as Array<{ id: string }>).map((s) => s.id)
        : host.workspace.sources.map((s) => s.id);
    for (const id of ids) {
      sources.push({ id, path: path.join(sourcesPath, id) });
    }
  }

  const spec = await loadSealedSpec(host, claim, runDir);
  const policy = policyForSpec(spec);
  const hasSources = sources.length > 0;
  const requiredPages =
    policy.mechanical.requireCriticalPages && spec?.pages
      ? spec.pages.map((p) => ({ path: p.path, critical: p.critical }))
      : undefined;

  // Host-owned indexes before score (EvaluationPolicy.autoFix.regenerateIndexes).
  if (policy.mechanical.autoFix.regenerateIndexes) {
    try {
      await regenerateWikiIndexes(stagingWiki);
    } catch {
      // Index regen is best-effort; missing layout still fails validate below.
    }
  }

  const wantAutofix =
    hasSources &&
    (policy.mechanical.autoFix.canonicalizeCitations ||
      policy.mechanical.autoFix.clampCitationLines);

  const result = await validateWikiTree(stagingWiki, {
    sources: hasSources ? sources : undefined,
    // Single mechanical contract for pre and final (no weaker pre path).
    requireCitations: hasSources ? policy.mechanical.requireCitations : false,
    autofixCitations: wantAutofix,
    lineSlack: policy.mechanical.autoFix.clampLineSlack,
    ...(requiredPages && requiredPages.length > 0 ? { requiredPages } : {}),
  });
  const mechanical = toMechanicalReport(result);
  const reportPath = path.join(workDir, "validate-report.json");
  const reportBody = {
    ...result,
    mechanical,
    kind: claim.kind,
    autofixCitations: wantAutofix,
    requireCitations: hasSources ? policy.mechanical.requireCitations : false,
  };
  // Always write the report on disk (success seals it; failure keeps the path for
  // operator diagnostics — PiAttemptOutcome.failed cannot carry unsealedArtifacts).
  await writeFile(reportPath, `${JSON.stringify(reportBody, null, 2)}\n`, "utf8");

  if (!result.ok) {
    // Quality / mechanical dirty — not missing infrastructure. The Scheduler seals
    // this full report before making the Attempt terminal, then hands its typed
    // issues to repair.N under EvaluationPolicy.mechanical.modelRepairBudget.
    return {
      type: "failed",
      error: `validation failed: ${mechanical.issues.length} issue(s); see sealed validate_report`,
      failureClass: "schema",
      unsealedArtifacts: [
        { kind: "receipt", role: "validate_report", sourcePath: reportPath, directory: false },
      ],
    };
  }
  const validateSummary = `${claim.kind} ok (${result.pageCount ?? 0} pages)`;
  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary: validateSummary,
    meta: { kind: claim.kind, ok: true, autofixCitations: wantAutofix },
  });
  return {
    type: "succeeded",
    unsealedArtifacts: [
      // Staging may include host autofix rewrites — re-seal as the refined wiki_tree.
      { kind: "wiki_tree", role: "wiki_tree", sourcePath: stagingWiki, directory: true },
      { kind: "receipt", role: "validate_report", sourcePath: reportPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: validateSummary,
  };
}
