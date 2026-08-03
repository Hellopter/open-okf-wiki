/**
 * Deep publication apply control (ADR 0035).
 *
 * Owns durable control-plane decisions around sealed-candidate apply:
 * beginApply CAS under the publication lock, and post-apply consequences
 * (effect applied / conflict + gate reopen / run park).
 *
 * Effect state transitions stay in publication-effect.ts (do not rename ADR
 * 0035 states). Conflict is an operator decision point — never fail the whole Run.
 *
 * Callers: mechanical/publish (thin executor).
 */

import type { ApplySealedPublicationResult } from "@okf-wiki/core";
import { now } from "./crypto-util.js";
import type { WikiRunsControl, WikiRunsTxCtx } from "./ctx.js";
import {
  transitionCandidateReadyToApplying,
  transitionToApplied,
  transitionToConflict,
} from "./publication-effect.js";
import { asRow, parseJson, requiredNumber, requiredText } from "./sql.js";

/** Control surface for publication apply CAS + post-apply parking. */
export type PublicationApplyControl = Pick<
  WikiRunsControl,
  keyof WikiRunsTxCtx | "currentNodeGeneration"
>;

/** Binding between a candidate_ready effect, its publication gate, and owning node gen. */
export type PublicationApplyBinding = {
  runId: string;
  effectKey: string;
  gateId: string;
  publicationNodeKey: string;
  publicationNodeGeneration: number;
};

/**
 * CAS under the publication lock (after live baseline matches, before rename):
 * cancel_requested=0, owning generation still current, gate still approved,
 * then candidate_ready → applying.
 */
export function beginPublicationApply(
  host: PublicationApplyControl,
  binding: PublicationApplyBinding,
): boolean {
  let accepted = false;
  host.transaction(() => {
    const run = asRow(
      host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(binding.runId),
    );
    if (!run || requiredNumber(run, "cancel_requested") !== 0) return;

    const liveGen = host.currentNodeGeneration(binding.runId, binding.publicationNodeKey);
    if (liveGen !== binding.publicationNodeGeneration) return;

    const gate = asRow(
      host.db
        .prepare(
          `SELECT state, decision_json FROM gates
           WHERE gate_id = ? AND run_id = ? AND kind = 'publication'`,
        )
        .get(binding.gateId, binding.runId),
    );
    if (!gate || requiredText(gate, "state") !== "resolved") return;
    const decision = parseJson<{ decision?: string }>(gate.decision_json);
    if (decision.decision !== "approve") return;

    if (!transitionCandidateReadyToApplying(host, binding.runId, binding.effectKey)) return;
    accepted = true;
  });
  return accepted;
}

/**
 * Durable control consequences of a sealed-candidate apply result.
 *
 * - applied → effect.applied
 * - conflict → effect.conflict, reopen publication gate (resolved→open),
 *   gate.publication → waiting, run → waiting_for_operator, emit gate.opened
 * - aborted → no control mutation (caller returns cancelled)
 *
 * Conflict does **not** fail the Run. The publish attempt still ends as
 * `failureClass: publication_conflict`; failNode blocks the publish node and
 * returns without terminal run failure.
 */
export function onPublicationApplyResult(
  host: PublicationApplyControl,
  binding: PublicationApplyBinding,
  result: ApplySealedPublicationResult,
): void {
  if (result.status === "applied") {
    host.transaction(() => {
      transitionToApplied(
        host,
        binding.runId,
        binding.effectKey,
        `published:${result.liveDigest}`,
      );
    });
    return;
  }

  if (result.status === "aborted") {
    return;
  }

  // result.status === "conflict"
  const timestamp = now();
  const observed = `PublicationConflict live=${result.liveDigest} expected=${result.expectedLiveDigest}`;
  host.transaction(() => {
    transitionToConflict(host, binding.runId, binding.effectKey, observed);
    host.db
      .prepare(
        `UPDATE gates
         SET state = 'open', decision_json = NULL, detail_json = ?, opened_at = ?,
             opened_revision = (SELECT revision FROM runs WHERE run_id = ?)
         WHERE gate_id = ? AND run_id = ? AND kind = 'publication' AND state = 'resolved'`,
      )
      .run(
        JSON.stringify({
          summary:
            "Publication conflict: the published Wiki changed after this candidate was sealed.",
          expectedLiveDigest: result.expectedLiveDigest,
          observedLiveDigest: result.liveDigest,
        }),
        timestamp,
        binding.runId,
        binding.gateId,
        binding.runId,
      );
    host.db
      .prepare(
        `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = 'gate.publication'
           AND generation = (SELECT node_generation FROM gates WHERE gate_id = ?)`,
      )
      .run(binding.runId, binding.gateId);
    host.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, binding.runId);
    host.emit(binding.runId, "gate.opened");
  });
}
