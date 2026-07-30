/**
 * Single repair kind (`repair.N`) + EvaluationPolicy budgets (ADR 0038).
 * Mechanical vs semantic is RepairRequest.sources only — not node-key species.
 */

import type {
  EvaluationPolicy,
  PiAttemptFailureClass,
  RepairRequest,
  RepairSource,
  WikiRunSpecAcceptance,
} from "@okf-wiki/contract";
import {
  evaluationPolicyFromAcceptance,
  RepairRequestSchema,
  WikiRunSpecAcceptanceSchema,
} from "@okf-wiki/contract";
import {
  extractPagesFromValidationMessage,
  MECHANICAL_REPAIR_PAGE_CAP,
} from "@okf-wiki/core";
import type { WikiRunsDbCtx } from "./ctx.js";
import { now } from "./crypto-util.js";
import { loadSpecFromArtifact, unlockReadyNodes } from "./dag.js";
import {
  assertUnderMaxCandidates,
  countWikiCandidates,
  latestWikiCandidate,
} from "./evaluation/candidate.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";
import type { ClaimedNode } from "./types.js";

/** Product repair node keys: `repair.1`, `repair.2`, … */
export const REPAIR_NODE_PREFIX = "repair.";

/** Validate kinds that may auto-schedule mechanical model repair. */
const AUTO_MECHANICAL_REPAIR_KINDS: ReadonlySet<string> = new Set([
  "validate.pre",
  "validate.final",
]);

/** Shared surface for loading sealed Spec acceptance and scheduling repairs. */
export type RepairScheduleHost = WikiRunsDbCtx & {
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  applyRerunAt(
    runId: string,
    nodeKey: string,
    generation: number,
    feedback?: string,
    opts?: { selfOnly?: boolean; excludeConsumer?: (nodeKey: string) => boolean },
  ): void;
  /** When true, auto mechanical repair is suppressed (owner closed). */
  closed?: boolean;
};

export function isRepairNodeKey(nodeKey: string): boolean {
  return /^repair\.\d+$/.test(nodeKey);
}

export function repairNodeKey(round: number): string {
  return `${REPAIR_NODE_PREFIX}${round}`;
}

/**
 * Build a structured RepairRequest for mechanical validation failures.
 * Pages are extracted from `path.md: …` segments (cap 8).
 */
export function buildMechanicalRepairRequest(opts: {
  runId: string;
  round: number;
  validationMessage: string;
  baselineCandidateId?: string;
}): RepairRequest {
  const pages = extractPagesFromValidationMessage(
    opts.validationMessage,
    MECHANICAL_REPAIR_PAGE_CAP,
  );
  const message = opts.validationMessage.trim().slice(0, 4_000) || "mechanical validation failed";
  return RepairRequestSchema.parse({
    requestId: `repair:mechanical:${opts.runId}:${opts.round}`,
    baselineCandidateId: opts.baselineCandidateId?.trim() || "pending",
    round: opts.round,
    sources: ["mechanical"],
    issues: [{ kind: "mechanical", message }],
    scope: {
      pages,
      mode: "patch",
    },
  });
}

/**
 * Build RepairRequest for council / operator fix.
 * Pages may be empty — defects arrive via sealed inputs.
 */
export function buildSemanticRepairRequest(opts: {
  runId: string;
  round: number;
  feedback?: string;
  source?: "semantic" | "operator";
  baselineCandidateId?: string;
  pages?: string[];
}): RepairRequest {
  const source: RepairSource = opts.source ?? "semantic";
  const message =
    opts.feedback?.trim().slice(0, 4_000) ||
    `Repair (round ${opts.round}): address sealed defects`;
  return RepairRequestSchema.parse({
    requestId: `repair:${source}:${opts.runId}:${opts.round}`,
    baselineCandidateId: opts.baselineCandidateId?.trim() || "pending",
    round: opts.round,
    sources: [source],
    issues: [{ kind: source, message }],
    scope: {
      pages: opts.pages ?? [],
      mode: "patch",
    },
  });
}

/**
 * Load sealed Spec acceptance from plan node_outputs role=spec.
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

export function loadEvaluationPolicy(
  host: Pick<RepairScheduleHost, "db" | "workspace">,
  runId: string,
): EvaluationPolicy {
  const acceptance = loadAcceptance(host, runId);
  return evaluationPolicyFromAcceptance(
    WikiRunSpecAcceptanceSchema.parse(acceptance ?? {}),
  );
}

/** All prior `repair.N` stages (single family). */
export function countRepairs(host: Pick<RepairScheduleHost, "db">, runId: string): number {
  const keys = asRows(
    host.db
      .prepare(`SELECT DISTINCT node_key FROM nodes WHERE run_id = ? AND node_key LIKE 'repair.%'`)
      .all(runId),
  )
    .map((r) => requiredText(r, "node_key"))
    .filter((k) => isRepairNodeKey(k));
  return keys.length;
}

/** Count repair nodes whose detail sources include the given source. */
export function countRepairsBySource(
  host: Pick<RepairScheduleHost, "db">,
  runId: string,
  source: RepairSource,
): number {
  const rows = asRows(
    host.db
      .prepare(
        `SELECT node_key, detail_json FROM nodes
         WHERE run_id = ? AND node_key LIKE 'repair.%' AND detail_json IS NOT NULL`,
      )
      .all(runId),
  );
  let count = 0;
  for (const row of rows) {
    const key = requiredText(row, "node_key");
    if (!isRepairNodeKey(key)) continue;
    const raw = row.detail_json;
    if (raw == null || raw === "") continue;
    try {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      const req = parsed.repairRequest;
      if (req && typeof req === "object" && !Array.isArray(req)) {
        const sources = (req as { sources?: unknown }).sources;
        if (Array.isArray(sources) && sources.includes(source)) {
          count += 1;
          continue;
        }
      }
      // Fallback: top-level source field (including transitional labels).
      const top = parsed.source;
      if (
        top === source ||
        (top === "hard_validate" && source === "mechanical") ||
        (top === "review" && source === "semantic")
      ) {
        count += 1;
      }
    } catch {
      // ignore corrupt detail
    }
  }
  return count;
}

export function loadSemanticRepairBudget(
  host: Pick<RepairScheduleHost, "db" | "workspace">,
  runId: string,
): number {
  return loadEvaluationPolicy(host, runId).semantic.modelRepairBudget;
}

export function loadMechanicalRepairBudget(
  host: Pick<RepairScheduleHost, "db" | "workspace">,
  runId: string,
): number {
  return loadEvaluationPolicy(host, runId).mechanical.modelRepairBudget;
}

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

export type ScheduleRepairInput = {
  runId: string;
  repairRequest: RepairRequest;
  feedback: string;
  /** Upstream node that supplies wiki (write.root or review.reduce). */
  wikiUpstreamKey: string;
  /**
   * After repair succeeds, always re-arm full EvaluationRound.
   * When scheduling, hold gate.fix + validate.final and wire repair → validate.pre.
   * For auto mechanical from validate.final mid-path, also re-arm the failed validate key.
   */
  failedValidateKey?: string;
  autoRepair?: boolean;
};

/**
 * Insert `repair.N`, wire edges, hold publication path until EvaluationRound re-runs.
 * Single product entry for mechanical auto-repair and operator/council fix.
 */
export function scheduleRepair(host: RepairScheduleHost, input: ScheduleRepairInput): string {
  const policy = loadEvaluationPolicy(host, input.runId);
  assertUnderMaxCandidates(host, input.runId, policy.maxCandidates);

  const sources = input.repairRequest.sources;
  const needsMechanical = sources.includes("mechanical");
  const needsSemantic =
    sources.includes("semantic") || sources.includes("operator");

  if (needsMechanical) {
    const budget = policy.mechanical.modelRepairBudget;
    const prior = countRepairsBySource(host, input.runId, "mechanical");
    if (budget <= 0 || prior >= budget) {
      throw new Error(
        `mechanical repair budget exhausted or zero (${prior}/${budget})`,
      );
    }
  }
  if (needsSemantic) {
    const budget = policy.semantic.modelRepairBudget;
    const prior = countRepairsBySource(host, input.runId, "semantic");
    if (budget <= 0 || prior >= budget) {
      throw new Error(
        `semantic repair budget exhausted or zero (${prior}/${budget}); only pass or deny allowed`,
      );
    }
  }

  const round = countRepairs(host, input.runId) + 1;
  const key = repairNodeKey(round);
  const existing = asRow(
    host.db
      .prepare("SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? LIMIT 1")
      .get(input.runId, key),
  );
  if (existing) throw new Error(`repair node already exists: ${key}`);

  const baseline =
    input.repairRequest.baselineCandidateId !== "pending"
      ? input.repairRequest.baselineCandidateId
      : latestWikiCandidate(host, input.runId)?.candidateId;

  const repairRequest = RepairRequestSchema.parse({
    ...input.repairRequest,
    round,
    baselineCandidateId: baseline?.trim() || input.repairRequest.baselineCandidateId,
    requestId: input.repairRequest.requestId.includes(`:${round}`)
      ? input.repairRequest.requestId
      : `repair:${input.runId}:${round}`,
  });

  const primarySource = needsMechanical
    ? "mechanical"
    : needsSemantic
      ? sources.includes("operator")
        ? "operator"
        : "semantic"
      : "mechanical";

  const detailJson = JSON.stringify({
    feedback: input.feedback,
    repairRequest,
    source: primarySource,
    round,
    autoRepair: input.autoRepair === true,
    baselineCandidateId: repairRequest.baselineCandidateId,
    ...(input.failedValidateKey ? { validateNodeKey: input.failedValidateKey } : {}),
  });

  host.db
    .prepare(
      `INSERT INTO nodes (
        run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
      ) VALUES (?, ?, 'repair', 'ready', 0, NULL, NULL, ?)`,
    )
    .run(input.runId, key, detailJson);

  // Wiki upstream → repair (binding).
  host.db
    .prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(input.runId, input.wikiUpstreamKey, key);

  // repair → validate.pre (full EvaluationRound re-entry — never final bypass).
  host.db
    .prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, 'validate.pre')
       ON CONFLICT DO NOTHING`,
    )
    .run(input.runId, key);

  // Hold gate.fix + validate.final until EvaluationRound re-runs.
  // applyRerunAt marks the root ready; demote so they are not stuck "ready"
  // (unclaimable gates / validate.final without upstreams) while repair runs.
  for (const holdKey of ["gate.fix", "validate.final"] as const) {
    const holdGen = host.currentNodeGeneration(input.runId, holdKey);
    if (holdGen === undefined) continue;
    try {
      host.applyRerunAt(input.runId, holdKey, holdGen);
      const next = host.currentNodeGeneration(input.runId, holdKey);
      if (next !== undefined) {
        host.db
          .prepare(
            `UPDATE nodes SET state = 'blocked'
             WHERE run_id = ? AND node_key = ? AND generation = ? AND state = 'ready'`,
          )
          .run(input.runId, holdKey, next);
      }
    } catch {
      // already bumped
    }
  }

  // If auto-repair from a failed validate node, invalidate that generation too.
  // Root becomes ready so validate re-claims after repair.N succeeds.
  if (input.failedValidateKey) {
    const g = host.currentNodeGeneration(input.runId, input.failedValidateKey);
    if (g !== undefined) {
      try {
        host.applyRerunAt(input.runId, input.failedValidateKey, g);
      } catch {
        // already bumped
      }
    }
  }

  return key;
}

/**
 * Operator / council fix → scheduleRepair (semantic source).
 */
export function scheduleOperatorRepair(
  host: RepairScheduleHost,
  command: { runId: string; feedback?: string },
  timestamp: string,
): void {
  const policy = loadEvaluationPolicy(host, command.runId);
  const budget = policy.semantic.modelRepairBudget;
  if (budget <= 0) {
    throw new Error(
      "semantic repair budget is 0 (acceptance.maxRepairRounds); only pass or deny allowed",
    );
  }
  const prior = countRepairsBySource(host, command.runId, "semantic");
  if (prior >= budget) {
    throw new Error(
      `semantic repair budget exhausted (${prior}/${budget}); only pass or deny allowed`,
    );
  }
  assertUnderMaxCandidates(host, command.runId, policy.maxCandidates);

  const round = countRepairs(host, command.runId) + 1;
  const notes = command.feedback?.trim();
  const feedback =
    notes && notes.length > 0
      ? notes
      : `Repair (round ${round}/${budget}): address sealed defects from review.reduce`;
  const baseline = latestWikiCandidate(host, command.runId);
  const repairRequest = buildSemanticRepairRequest({
    runId: command.runId,
    round,
    feedback,
    source: "semantic",
    baselineCandidateId: baseline?.candidateId,
  });

  scheduleRepair(host, {
    runId: command.runId,
    repairRequest,
    feedback,
    wikiUpstreamKey: "review.reduce",
    autoRepair: false,
  });

  unlockReadyNodes(host, command.runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, command.runId);
  host.emit(command.runId, "node.ready");
}

/**
 * After any repair.N succeeds, re-arm full EvaluationRound:
 * validate.pre → review.seat.* → review.reduce.
 * selfOnly so the repair node is not lineage-invalidated.
 *
 * Only validate.pre is left claimable immediately. Seats/reduce are demoted to
 * invalidated so unlockReadyNodes promotes them only after validate.pre succeeds —
 * otherwise budget-exhausted validate failure leaves unclaimable ready seats and
 * the run never reaches failed.
 */
export function rearmEvaluationRoundAfterRepair(
  host: RepairScheduleHost,
  runId: string,
): void {
  const seatKeys = asRows(
    host.db
      .prepare(
        `SELECT DISTINCT node_key FROM nodes
         WHERE run_id = ? AND kind = 'review.seat'
         ORDER BY node_key`,
      )
      .all(runId),
  ).map((row) => requiredText(row, "node_key"));

  const keys = ["validate.pre", ...seatKeys, "review.reduce"];
  for (const key of keys) {
    const g = host.currentNodeGeneration(runId, key);
    if (g === undefined) continue;
    try {
      host.applyRerunAt(runId, key, g, undefined, { selfOnly: true });
    } catch {
      // already bumped
    }
  }

  // Demote seats/reduce off ready — they must wait for validate.pre via unlock.
  for (const key of [...seatKeys, "review.reduce"]) {
    const g = host.currentNodeGeneration(runId, key);
    if (g === undefined) continue;
    host.db
      .prepare(
        `UPDATE nodes SET state = 'invalidated'
         WHERE run_id = ? AND node_key = ? AND generation = ? AND state = 'ready'`,
      )
      .run(runId, key, g);
  }
}

/**
 * Auto model repair after validate.pre/final schema failure.
 * Returns true when a repair.N stage was scheduled.
 */
export function scheduleMechanicalRepair(
  host: RepairScheduleHost,
  claim: ClaimedNode,
  message: string,
): boolean {
  if (currentWriteRootGeneration(host, claim.runId) === undefined) return false;

  const policy = loadEvaluationPolicy(host, claim.runId);
  const budget = policy.mechanical.modelRepairBudget;
  const prior = countRepairsBySource(host, claim.runId, "mechanical");
  if (budget <= 0 || prior >= budget) return false;
  if (countWikiCandidates(host, claim.runId) >= policy.maxCandidates) return false;

  const round = countRepairs(host, claim.runId) + 1;
  const baseline = latestWikiCandidate(host, claim.runId);
  const feedback = [`Mechanical repair (round ${round}/${budget}):`, message].join("\n");
  const repairRequest = buildMechanicalRepairRequest({
    runId: claim.runId,
    round,
    validationMessage: message,
    baselineCandidateId: baseline?.candidateId,
  });

  try {
    scheduleRepair(host, {
      runId: claim.runId,
      repairRequest,
      feedback,
      wikiUpstreamKey: "write.root",
      failedValidateKey: claim.nodeKey,
      autoRepair: true,
    });
    unlockReadyNodes(host, claim.runId);
    const timestamp = now();
    host.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    return true;
  } catch {
    return false;
  }
}

export function shouldAutoMechanicalRepair(
  host: RepairScheduleHost,
  claim: ClaimedNode,
  message: string,
  failureClass?: string | PiAttemptFailureClass,
): boolean {
  if (!AUTO_MECHANICAL_REPAIR_KINDS.has(claim.kind)) return false;
  if (host.closed) return false;
  const run = asRow(
    host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
  );
  if (!run || requiredNumber(run, "cancel_requested") === 1) return false;

  const cls = failureClass?.trim().toLowerCase();
  if (cls === "infrastructure" || cls === "cancelled" || cls === "cancel") return false;
  if (cls === "capacity" || cls === "budget" || cls === "policy" || cls === "provider") {
    return false;
  }

  const isSchema = cls === "schema" || cls === "quality";
  const isValidationMessage = /validation failed:/i.test(message);
  if (!isSchema && !isValidationMessage) return false;

  if (currentWriteRootGeneration(host, claim.runId) === undefined) return false;

  const policy = loadEvaluationPolicy(host, claim.runId);
  if (policy.mechanical.modelRepairBudget <= 0) return false;
  if (countRepairsBySource(host, claim.runId, "mechanical") >= policy.mechanical.modelRepairBudget) {
    return false;
  }
  if (countWikiCandidates(host, claim.runId) >= policy.maxCandidates) return false;

  return true;
}

/** Feedback prefix for auto mechanical repair rounds (detail / tests). */
export const MECHANICAL_REPAIR_FEEDBACK_PREFIX = "Mechanical repair (";
