/**
 * Single post-success entry after a sealed attempt CAS commit.
 * Owns gate open / plan auto-approve / unlock / run-state transitions that used
 * to live inside commitNodeArtifacts (artifacts stays bytes+CAS only).
 * Also owns prepared-artifact recovery (CAS + control-flow in one path).
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WikiRunEvent, WorkspaceConfig } from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import {
  type ArtifactsHost,
  commitNodeArtifacts,
  loadSealedDefectsReport,
  verifyArtifact,
} from "./artifacts.js";
import { digest, now } from "./crypto-util.js";
import { unlockReadyNodes } from "./dag.js";
import { commitFreezeArtifacts, type FreezeCommitHost, trustedFrozenInputs } from "./freeze.js";
import {
  autoPassFixGate,
  openFixGate,
  openPlanGate,
  openPublicationGate,
  readPublicationBaseline,
} from "./gate-open.js";
import { onPlanAccepted } from "./gate-resolve.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import type { ArtifactPreparation, ClaimedFreeze, ClaimedNode } from "./types.js";

/** Host for successful-attempt side effects (gates + unlock + plan accept). */
export type AttemptSuccessHost = {
  workspace: WorkspaceConfig;
  db: DatabaseSync;
  emit(runId: string, type: WikiRunEvent["type"]): number;
  isCurrent(claim: ClaimedNode): boolean;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
};

/** Recovery needs transaction + the success host surface. */
export type RecoverArtifactsHost = AttemptSuccessHost & Pick<ArtifactsHost, "transaction">;

function freezeCommitHost(host: AttemptSuccessHost): FreezeCommitHost {
  return {
    db: host.db,
    isCurrent: (claim) => host.isCurrent(claim),
    emit: (runId, type) => host.emit(runId, type),
  };
}

function orphanPreparedGroup(host: RecoverArtifactsHost, attemptId: string): void {
  host.transaction(() =>
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(attemptId),
  );
}

/**
 * ADR 0035 recovery: replay only prepared, verified artifacts whose Attempt is
 * still current (`isCurrent` inside commit). Route by preparation `node_key`:
 * freeze → `commitFreezeArtifacts`; all other nodes → `commitSuccessfulAttempt`
 * (CAS + gate open / unlock / plan accept).
 */
export async function recoverPreparedArtifacts(host: RecoverArtifactsHost): Promise<void> {
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
        .prepare(
          "SELECT kind FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
        )
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

/**
 * Control-flow after CAS seal of a successful attempt (same transaction).
 * Caller must have already run commitNodeArtifacts (or use commitSuccessfulAttempt).
 */
export function onAttemptSucceeded(
  host: AttemptSuccessHost,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
  timestamp: string = now(),
): void {
  if (claim.kind === "plan") {
    const specPrep = preparations.find((item) => item.role === "spec" || item.kind === "spec");
    if (!specPrep) throw new Error("plan attempt succeeded without a Spec artifact");
    // planConfirm=false: auto-approve — same onPlanAccepted path as ResolveGate approve.
    if (host.workspace.planConfirm === false) {
      onPlanAccepted(host, claim.runId, specPrep.relativePath, timestamp);
      return;
    }
    openPlanGate(host, claim, specPrep.digest, timestamp);
    return;
  }
  if (claim.kind === "prepare.publication") {
    const candidate = preparations.find(
      (item) => item.role === "publication_candidate" || item.kind === "publication_candidate",
    );
    if (!candidate) throw new Error("prepare.publication succeeded without a candidate");
    const expectedLiveDigest = readPublicationBaseline(host, claim.runId, preparations);
    openPublicationGate(host, claim, candidate, expectedLiveDigest, timestamp);
    return;
  }
  if (claim.kind === "review.reduce") {
    // Always succeed path: open gate.fix on blocking defects, else auto-pass.
    // Non-blocking (major/minor) alone do not hold the run — MVP matches "no blocking".
    const defectsPrep = preparations.find((item) => item.role === "defects");
    const report = loadSealedDefectsReport(host, claim.runId, defectsPrep);
    const blocking = report?.defects.filter((d) => d.severity === "blocking") ?? [];
    if (blocking.length === 0) {
      autoPassFixGate(host, claim.runId, timestamp);
      return;
    }
    const payloadDigest =
      defectsPrep?.digest ?? digest(report ?? { clean: false, defects: blocking });
    openFixGate(host, claim, payloadDigest, timestamp, {
      summary: report?.summary,
      clean: false,
      blockingCount: blocking.length,
    });
    return;
  }
  if (claim.kind === "publish") {
    host.db
      .prepare(
        "UPDATE runs SET state = 'published', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    host.emit(claim.runId, "run.published");
    return;
  }

  unlockReadyNodes(host, claim.runId);
  const hasReady = asRow(
    host.db
      .prepare(
        `SELECT 1 AS present FROM nodes
         WHERE run_id = ? AND state = 'ready'
           AND generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )
         LIMIT 1`,
      )
      .get(claim.runId),
  );
  // Open gates table is the HITL authority — do not treat stale gate.* nodes
  // left in state='waiting' after Rerun/withdraw as operator waits (parallel
  // seat commits used to flip the run to waiting_for_operator and stall).
  const hasOpenGate = asRow(
    host.db
      .prepare(`SELECT 1 AS present FROM gates WHERE run_id = ? AND state = 'open' LIMIT 1`)
      .get(claim.runId),
  );
  if (hasReady) {
    // Ready work wins over a stale waiting_for_operator (e.g. withdrawn pub gate
    // node still marked waiting while review.reduce is ready).
    host.db
      .prepare(
        `UPDATE runs SET state = 'queued', updated_at = ?
         WHERE run_id = ? AND cancel_requested = 0
           AND state IN ('running', 'queued', 'waiting_for_operator')`,
      )
      .run(timestamp, claim.runId);
    host.emit(claim.runId, "node.ready");
  } else if (hasOpenGate) {
    host.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
  } else {
    // Keep running if blocked work may unlock later; otherwise leave state as running
    // until a terminal transition (publish / completed_unpublished / failed).
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
  }
}

/**
 * Single entry used by scheduler success path and prepared-artifact recovery:
 * CAS commit bytes + attempt/node success, then gate open / unlock / plan accept.
 * Must run inside the owner's outer transaction.
 */
export function commitSuccessfulAttempt(
  host: AttemptSuccessHost,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
): void {
  const committed = commitNodeArtifacts(host, claim, preparations);
  if (!committed) return;
  // commitNodeArtifacts already stamped ended_at; reuse now() for run-state updates
  // (same second granularity as before when control flow lived inside commit).
  onAttemptSucceeded(host, claim, preparations);
}
