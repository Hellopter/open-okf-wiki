/**
 * Mechanical validate.pre / validate.final execution.
 */

import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract";
import { validateWikiTree } from "@okf-wiki/core";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { type MechanicalHost, sealedInputPath } from "./host.js";

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
  const result = await validateWikiTree(stagingWiki, {
    sources: sources.length > 0 ? sources : undefined,
    // Pre-review validate is structural; final still checks citations when sources exist.
    requireCitations: claim.kind === "validate.final" ? undefined : false,
  });
  if (!result.ok) {
    // Quality / mechanical dirty — not missing infrastructure. Scheduler may
    // auto-schedule repair.hv.N under acceptance.maxHardValidateRepairRounds.
    return {
      type: "failed",
      error: `validation failed: ${result.errors.slice(0, 8).join("; ")}`.slice(0, 4_000),
      failureClass: "schema",
    };
  }
  const reportPath = path.join(workDir, "validate-report.json");
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const validateSummary = `${claim.kind} ok (${result.pageCount ?? 0} pages)`;
  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary: validateSummary,
    meta: { kind: claim.kind, ok: true },
  });
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "wiki_tree", role: "wiki_tree", sourcePath: stagingWiki, directory: true },
      { kind: "receipt", role: "validate_report", sourcePath: reportPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: validateSummary,
  };
}
