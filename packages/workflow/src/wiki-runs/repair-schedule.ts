/**
 * Independent repair budgets: council review.repair.N vs hard-validate repair.hv.N.
 * Shared loadAcceptance / sealed Spec helpers — counters stay separate (ADR acceptance).
 */

import type {
  PiAttemptFailureClass,
  WikiRunSpecAcceptance,
} from "@okf-wiki/contract";
import type { WikiRunsDbCtx } from "./ctx.js";
import { now } from "./crypto-util.js";
import { loadSpecFromArtifact, unlockReadyNodes } from "./dag.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";
import type { ClaimedNode } from "./types.js";

/** Dedicated review-repair node keys: `repair.review.1`, `repair.review.2`, … */
export const REVIEW_REPAIR_NODE_PREFIX = "repair.review.";

/** Feedback prefix used to count prior auto hard-validate repairs (legacy write.root + repair.hv). */
export const HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX = "Hard-validate repair (";

/** Dedicated auto hard-validate repair node keys: `repair.hv.1`, `repair.hv.2`, … */
export const HARD_VALIDATE_REPAIR_NODE_PREFIX = "repair.hv.";

/** Validate kinds that may trigger durable auto hard-validate repair via repair.hv.N. */
const HARD_VALIDATE_REPAIR_KINDS: ReadonlySet<string> = new Set([
  "validate.pre",
  "validate.final",
]);

/** Shared surface for loading sealed Spec acceptance and scheduling repairs. */
export type RepairScheduleHost = WikiRunsDbCtx & {
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  /**
   * Durable RerunNode core (generation++ + lineage invalidation + optional feedback).
   * Used to re-arm validate.* / validate.final after scheduling a repair stage.
   */
  applyRerunAt(runId: string, nodeKey: string, generation: number, feedback?: string): void;
  /** When true, auto HV repair is suppressed (owner closed). */
  closed?: boolean;
};

/**
 * Load sealed Spec acceptance from plan node_outputs role=spec.
 * Shared by council maxRepairRounds and HV maxHardValidateRepairRounds loaders.
 */
export function loadAcceptance(
  host: Pick<RepairScheduleHost, "db" | "workspace">,
  runId: string,
): WikiRunSpecAcceptance | undefined {
  const plan = asRow(
    host.db
      .prepare(
        `SELECT artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'plan'
           AND node_outputs.role = 'spec'
         ORDER BY node_outputs.node_generation DESC
         LIMIT 1`,
      )
      .get(runId),
  );
  if (!plan) return undefined;
  const relativePath = requiredText(plan, "relative_path");
  const spec = loadSpecFromArtifact(host, runId, relativePath);
  return spec?.acceptance;
}

/**
 * Count prior review repair stages (`repair.review.N`).
 * Used to enforce Spec acceptance.maxRepairRounds on ResolveGate(fix).
 */
export function countReviewRepairs(host: Pick<RepairScheduleHost, "db">, runId: string): number {
  const row = asRow(
    host.db
      .prepare(
        `SELECT COUNT(DISTINCT node_key) AS count FROM nodes
         WHERE run_id = ? AND node_key LIKE 'repair.review.%'`,
      )
      .get(runId),
  );
  return requiredNumber(row ?? { count: 0 }, "count");
}

/**
 * Load sealed Spec acceptance.maxRepairRounds (default 2).
 */
export function loadReviewRepairBudget(
  host: Pick<RepairScheduleHost, "db" | "workspace">,
  runId: string,
): number {
  const acceptance = loadAcceptance(host, runId);
  const budget = acceptance?.maxRepairRounds;
  return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 2;
}

/**
 * Insert repair.review.N (kind=repair), wire edges from review.reduce → repair → validate.final,
 * and re-arm validate.final so it waits for the repair stage.
 */
export function scheduleReviewRepair(
  host: RepairScheduleHost,
  command: {
    runId: string;
    feedback?: string;
  },
  timestamp: string,
): void {
  const budget = loadReviewRepairBudget(host, command.runId);
  if (budget <= 0) {
    throw new Error(
      "review repair budget is 0 (acceptance.maxRepairRounds); only pass or deny allowed",
    );
  }
  const prior = countReviewRepairs(host, command.runId);
  if (prior >= budget) {
    throw new Error(
      `review repair budget exhausted (${prior}/${budget}); only pass or deny allowed`,
    );
  }

  const round = prior + 1;
  const key = `${REVIEW_REPAIR_NODE_PREFIX}${round}`;
  const existing = asRow(
    host.db
      .prepare("SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? LIMIT 1")
      .get(command.runId, key),
  );
  if (existing) throw new Error(`review repair node already exists: ${key}`);

  const notes = command.feedback?.trim();
  const feedback =
    notes && notes.length > 0
      ? notes
      : `Review repair (round ${round}/${budget}): address sealed defects from review.reduce`;
  const detailJson = JSON.stringify({
    feedback,
    source: "review",
    round,
    autoRepair: false,
  });

  host.db
    .prepare(
      `INSERT INTO nodes (
        run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
      ) VALUES (?, ?, 'repair', 'ready', 0, NULL, NULL, ?)`,
    )
    .run(command.runId, key, detailJson);

  // review.reduce → repair.review.n (wiki_tree + defects); repair → validate.final
  host.db
    .prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'review.reduce', ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(command.runId, key);
  host.db
    .prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, 'validate.final')
       ON CONFLICT DO NOTHING`,
    )
    .run(command.runId, key);

  // Re-arm validate.final so it waits for repair (MVP: skip re-seats; repair → final).
  const finalGen = host.currentNodeGeneration(command.runId, "validate.final");
  if (finalGen !== undefined) {
    host.applyRerunAt(command.runId, "validate.final", finalGen);
  }

  unlockReadyNodes(host, command.runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, command.runId);
  host.emit(command.runId, "node.ready");
}

/**
 * Latest write.root generation (max generation row), if the node exists.
 * Required for auto hard-validate repair (wiki input source must exist).
 */
export function currentWriteRootGeneration(
  host: Pick<RepairScheduleHost, "db">,
  runId: string,
): number | undefined {
  const row = asRow(
    host.db
      .prepare(
        `SELECT MAX(generation) AS generation FROM nodes
         WHERE run_id = ? AND node_key = 'write.root'`,
      )
      .get(runId),
  );
  if (!row || row.generation === null) return undefined;
  return requiredNumber(row, "generation");
}

/**
 * Load sealed Spec acceptance.maxHardValidateRepairRounds (default 2).
 */
export function loadHardValidateBudget(
  host: Pick<RepairScheduleHost, "db" | "workspace">,
  runId: string,
): number {
  const acceptance = loadAcceptance(host, runId);
  const budget = acceptance?.maxHardValidateRepairRounds;
  return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 2;
}

/**
 * Count prior auto hard-validate repairs.
 * Prefer dedicated `repair.hv.N` nodes; fall back to legacy write.root detail
 * (old runs that disguised HV repair as write.root rerun).
 */
export function countAutoHardValidateRepairs(
  host: Pick<RepairScheduleHost, "db">,
  runId: string,
): number {
  const hvRow = asRow(
    host.db
      .prepare(
        `SELECT COUNT(DISTINCT node_key) AS count FROM nodes
         WHERE run_id = ? AND node_key LIKE 'repair.hv.%'`,
      )
      .get(runId),
  );
  const hvCount = requiredNumber(hvRow ?? { count: 0 }, "count");
  if (hvCount > 0) return hvCount;

  // Legacy: write.root generations whose detail_json carried HV feedback.
  const rows = asRows(
    host.db
      .prepare(
        `SELECT detail_json FROM nodes
         WHERE run_id = ? AND node_key = 'write.root' AND detail_json IS NOT NULL`,
      )
      .all(runId),
  );
  let count = 0;
  for (const row of rows) {
    const raw = row.detail_json;
    if (raw == null || raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      // Fall back to raw substring match for corrupt-but-prefixed detail.
      if (
        String(raw).includes(`"autoHardValidate":true`) ||
        String(raw).includes(HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX)
      ) {
        count += 1;
      }
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const detail = parsed as Record<string, unknown>;
    if (detail.autoHardValidate === true) {
      count += 1;
      continue;
    }
    if (
      typeof detail.feedback === "string" &&
      detail.feedback.startsWith(HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX)
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Insert a dedicated `repair.hv.N` stage, wire edges, and re-arm the failed
 * validate node (gen+1) so it waits for repair — without putting feedback on
 * validate or re-running write.root.
 *
 * Returns true when the repair stage was scheduled.
 */
export function scheduleHardValidateRepair(
  host: RepairScheduleHost,
  claim: ClaimedNode,
  message: string,
): boolean {
  if (currentWriteRootGeneration(host, claim.runId) === undefined) return false;

  const budget = loadHardValidateBudget(host, claim.runId);
  const prior = countAutoHardValidateRepairs(host, claim.runId);
  const round = prior + 1;
  const key = `${HARD_VALIDATE_REPAIR_NODE_PREFIX}${round}`;
  const feedback = [
    `${HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX}round ${round}/${budget}):`,
    message,
  ].join("\n");
  const detailJson = JSON.stringify({
    autoHardValidate: true,
    feedback,
    source: "hard_validate",
    round,
    validateNodeKey: claim.nodeKey,
  });

  try {
    const existing = asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? LIMIT 1",
        )
        .get(claim.runId, key),
    );
    if (existing) return false;

    host.db
      .prepare(
        `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, 'repair', 'ready', 0, NULL, NULL, ?)`,
      )
      .run(claim.runId, key, detailJson);

    // write.root → repair.hv.n (wiki input); repair.hv.n → validate (must wait).
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'write.root', ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(claim.runId, key);
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(claim.runId, key, claim.nodeKey);

    // Re-arm validate + downstream at gen+1 (invalidated until repair succeeds).
    // Do NOT put feedback on the validate node.
    host.applyRerunAt(claim.runId, claim.nodeKey, claim.nodeGeneration);
    unlockReadyNodes(host, claim.runId);
    const timestamp = now();
    host.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    return true;
  } catch {
    // Stale gen / constraint / missing write: fall through to normal fail-run path.
    return false;
  }
}

/**
 * Durable auto hard-validate repair after validate.pre / validate.final fails
 * with repairable schema/quality errors (message contains `validation failed:`).
 * Not for missing wiki_tree infrastructure.
 * Budget: sealed Spec acceptance.maxHardValidateRepairRounds (default 2).
 */
export function shouldAutoHardValidateRepair(
  host: RepairScheduleHost,
  claim: ClaimedNode,
  message: string,
  failureClass?: string | PiAttemptFailureClass,
): boolean {
  if (!HARD_VALIDATE_REPAIR_KINDS.has(claim.kind)) return false;
  if (host.closed) return false;
  const run = asRow(
    host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
  );
  if (!run || requiredNumber(run, "cancel_requested") === 1) return false;

  // Infrastructure (missing wiki_tree, …) never auto-repairs.
  const cls = failureClass?.trim().toLowerCase();
  if (cls === "infrastructure" || cls === "cancelled" || cls === "cancel") return false;
  if (cls === "capacity" || cls === "budget" || cls === "policy" || cls === "provider") {
    return false;
  }

  // Prefer typed schema/quality; also accept classic validation-failed messages.
  const isSchema = cls === "schema" || cls === "quality";
  const isValidationMessage = /validation failed:/i.test(message);
  if (!isSchema && !isValidationMessage) return false;

  if (currentWriteRootGeneration(host, claim.runId) === undefined) return false;

  const budget = loadHardValidateBudget(host, claim.runId);
  if (budget <= 0) return false;
  const prior = countAutoHardValidateRepairs(host, claim.runId);
  return prior < budget;
}
