/**
 * Mechanical prepare.publication — capture live baseline + materialize candidate.
 */

import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract";
import { capturePublicationBaseline, materializePublicationCandidate } from "@okf-wiki/core";
import { now } from "../crypto-util.js";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { mechanicalFailed } from "./failed.js";
import { type MechanicalHost, sealedInputPath } from "./host.js";

export async function mechanicalPreparePublication(
  host: MechanicalHost,
  claim: ClaimedNode,
  workDir: string,
  runDir: string,
): Promise<PiAttemptOutcome> {
  const wikiPath = sealedInputPath(host, claim, runDir, "wiki_tree");
  if (!wikiPath) {
    return mechanicalFailed({
      claim,
      runDir,
      error: "prepare.publication requires sealed wiki_tree",
      failureClass: "infrastructure",
    });
  }
  // Drop prior seal manifest so materialize digests content only.
  const wikiStaging = path.join(workDir, "wiki-source");
  await cp(wikiPath, wikiStaging, { recursive: true, dereference: false });
  await rm(path.join(wikiStaging, ".okf-artifact-manifest.json"), { force: true });

  const workspace = host.workspaceForRun(claim.runId);
  const publicationPath =
    workspace.publicationPath || path.join(workspace.rootPath, "published-wiki");

  // ADR 0035: capture live baseline under the publication lock before building.
  let expectedLiveDigest: string;
  try {
    expectedLiveDigest = await capturePublicationBaseline(publicationPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "baseline capture failed";
    return mechanicalFailed({
      claim,
      runDir,
      error: message.slice(0, 4_000),
      failureClass: "infrastructure",
    });
  }

  const sourcesPath = sealedInputPath(host, claim, runDir, "sources");
  const sources: Array<{ id: string; path: string }> = [];
  if (sourcesPath) {
    const pinned = host.trustedPinnedInputs(claim.runId);
    const ids = pinned
      ? (pinned.sources as Array<{ id: string }>).map((s) => s.id)
      : workspace.sources.map((s) => s.id);
    for (const id of ids) sources.push({ id, path: path.join(sourcesPath, id) });
  }

  const candidate = path.join(workDir, "publication-candidate");
  const stampAt = now();
  try {
    await materializePublicationCandidate({
      wikiDir: wikiStaging,
      candidateDir: candidate,
      publicationPath,
      ...(sources.length > 0 ? { sources } : {}),
      stamp: {
        generatedBy: "okf-wiki/workflow",
        generatedAt: stampAt,
        verified: [{ by: "process:review-council", at: stampAt }],
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "candidate materialize failed";
    return mechanicalFailed({
      claim,
      runDir,
      error: message.slice(0, 4_000),
      failureClass: "infrastructure",
    });
  }

  const metaPath = path.join(workDir, "candidate-meta.json");
  await writeFile(
    metaPath,
    `${JSON.stringify({
      schema: 1,
      expectedLiveDigest,
      publicationPath,
      publicationNodeKey: claim.nodeKey,
      publicationNodeGeneration: claim.nodeGeneration,
    })}\n`,
    "utf8",
  );
  const prepSummary = `publication candidate sealed (baseline ${expectedLiveDigest.slice(0, 12)}…)`;
  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary: prepSummary,
    meta: { ok: true, expectedLiveDigest },
  });
  return {
    type: "succeeded",
    unsealedArtifacts: [
      {
        kind: "publication_candidate",
        role: "publication_candidate",
        sourcePath: candidate,
        directory: true,
      },
      { kind: "receipt", role: "candidate_meta", sourcePath: metaPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: prepSummary,
  };
}
