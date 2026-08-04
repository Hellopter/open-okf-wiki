/**
 * ADR 0035 recovery: replay only prepared, verified artifacts whose Attempt is
 * still current (`isCurrent` inside commit). Route by preparation `node_key`:
 * freeze → `commitFreezeArtifacts`; all other nodes → `commitSuccessfulAttempt`
 * (CAS + gate open / unlock / plan accept).
 */

import path from "node:path";
import { runWorkDir } from "@okf-wiki/core";
import { verifyArtifact } from "../artifacts.js";
import type { WikiRunsControl } from "../ctx.js";
import { commitFreezeArtifacts, type FreezeCommitHost, trustedFrozenInputs } from "../freeze.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "../sql.js";
import {
  type ArtifactPreparation,
  type ClaimedFreeze,
  type ClaimedNode,
} from "../types.js";
import { commitSuccessfulAttempt } from "./on-success.js";
import { orphanPreparedGroup } from "./terminal-rows.js";

function freezeCommitHost(host: WikiRunsControl): FreezeCommitHost {
  return {
    db: host.db,
    isCurrent: (claim) => host.isCurrent(claim),
    emit: (runId, type) => host.emit(runId, type),
    workspace: host.workspace,
    currentNodeGeneration: (runId, nodeKey) => host.currentNodeGeneration(runId, nodeKey),
  };
}

export async function recoverPreparedArtifacts(host: WikiRunsControl): Promise<void> {
  const rows = asRows(
    host.db
      .prepare(
        `SELECT preparation_id, attempt_id, run_id, node_key, node_generation, artifact_id, kind, role,
                manifest_digest, relative_path
         FROM artifact_preparations WHERE state = 'prepared' ORDER BY attempt_id, preparation_id`,
      )
      .all(),
  );
  const grouped = new Map<string, SqlRow[]>();
  for (const row of rows) {
    const attemptId = requiredText(row, "attempt_id");
    grouped.set(attemptId, [...(grouped.get(attemptId) ?? []), row]);
  }
  for (const [attemptId, preparations] of grouped) {
    const first = preparations[0]!;
    const runId = requiredText(first, "run_id");
    const nodeKey = requiredText(first, "node_key");
    const nodeGeneration = requiredNumber(first, "node_generation");
    const valid = await Promise.all(
      preparations.map((preparation) =>
        verifyArtifact(
          path.join(
            runWorkDir(host.workspace.rootPath, runId),
            requiredText(preparation, "relative_path"),
          ),
          requiredText(preparation, "manifest_digest"),
        ),
      ),
    );
    if (!valid.every(Boolean)) {
      orphanPreparedGroup(host, attemptId);
      continue;
    }
    const prepared: ArtifactPreparation[] = preparations.map((preparation) => ({
      artifactId: requiredText(preparation, "artifact_id"),
      digest: requiredText(preparation, "manifest_digest"),
      kind: requiredText(preparation, "kind") as ArtifactPreparation["kind"],
      preparationId: requiredText(preparation, "preparation_id"),
      relativePath: requiredText(preparation, "relative_path"),
      role: requiredText(preparation, "role"),
      sourceDirectory: "",
    }));

    if (nodeKey === "freeze") {
      // Freeze commit also pins frozen_* → pinned_*; require attempt_output + durable freeze inputs.
      const output = preparations.find(
        (preparation) => requiredText(preparation, "role") === "attempt_output",
      );
      if (!output) {
        orphanPreparedGroup(host, attemptId);
        continue;
      }
      const inputs = trustedFrozenInputs({ db: host.db }, runId);
      if (!inputs) {
        orphanPreparedGroup(host, attemptId);
        continue;
      }
      const claim: ClaimedFreeze = {
        attemptId,
        nodeGeneration,
        nodeKey: "freeze",
        kind: "freeze",
        runId,
      };
      host.transaction(() => commitFreezeArtifacts(freezeCommitHost(host), claim, prepared));
      continue;
    }

    // Non-freeze prepared groups: rebuild claim from the node row and commit via
    // the same CAS + control-flow path as live execution.
    const node = asRow(
      host.db
        .prepare("SELECT kind FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(runId, nodeKey, nodeGeneration),
    );
    if (!node) {
      orphanPreparedGroup(host, attemptId);
      continue;
    }
    const claim: ClaimedNode = {
      attemptId,
      nodeGeneration,
      nodeKey,
      kind: requiredText(node, "kind"),
      runId,
    };
    host.transaction(() => commitSuccessfulAttempt(host, claim, prepared));
  }
}
