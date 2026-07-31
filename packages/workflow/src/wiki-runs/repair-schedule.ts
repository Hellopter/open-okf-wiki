/**
 * Single repair kind (`repair.N`) + EvaluationPolicy budgets (ADR 0038).
 * Mechanical vs semantic is RepairRequest.sources only — not node-key species.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  EvaluationPolicy,
  MechanicalReport,
  PiAttemptFailureClass,
  RepairRequest,
  RepairSource,
  WikiRunSpecAcceptance,
} from "@okf-wiki/contract";
import {
  contractForNode,
  evaluationPolicyFromAcceptance,
  MechanicalReportSchema,
  RepairRequestSchema,
  WikiRunSpecAcceptanceSchema,
} from "@okf-wiki/contract";
import { extractPagesFromValidationMessage, runWorkDir } from "@okf-wiki/core";
import { now } from "./crypto-util.js";
import type { WikiRunsDbCtx } from "./ctx.js";
import { loadSpecFromArtifact, unlockReadyNodes } from "./dag.js";
import {
  assertUnderMaxCandidates,
  countModelWikiCandidates,
  latestWikiCandidate,
  wikiCandidateById,
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
 * Uses the complete sealed MechanicalReport when one is available; the message
 * fallback only exists for old/incomplete attempts.
 */
export function buildMechanicalRepairRequest(opts: {
  runId: string;
  round: number;
  validationMessage: string;
  baselineCandidateId?: string;
  mechanicalReport?: MechanicalReport;
  mechanicalReportArtifactId?: string;
}): RepairRequest {
  const pages = opts.mechanicalReport
    ? [
        ...new Set(
          opts.mechanicalReport.issues.flatMap((issue) => (issue.path ? [issue.path] : [])),
        ),
      ]
    : extractPagesFromValidationMessage(opts.validationMessage);
  const message = opts.validationMessage.trim().slice(0, 4_000) || "mechanical validation failed";
  return RepairRequestSchema.parse({
    requestId: `repair:mechanical:${opts.runId}:${opts.round}`,
    baselineCandidateId: opts.baselineCandidateId?.trim() || "pending",
    round: opts.round,
    sources: ["mechanical"],
    issues: opts.mechanicalReport
      ? opts.mechanicalReport.issues.map((issue) => ({ kind: "mechanical", ...issue }))
      : [{ kind: "mechanical", message }],
    scope: {
      pages,
      mode: "patch",
    },
    ...(opts.mechanicalReportArtifactId
      ? { mechanicalReportArtifactId: opts.mechanicalReportArtifactId }
      : {}),
  });
}

/** Read the full validation report only from its sealed artifact directory. */
export function loadMechanicalReport(
  host: Pick<RepairScheduleHost, "db" | "workspace">,
  runId: string,
  artifactId: string | undefined,
): MechanicalReport | undefined {
  if (!artifactId) return undefined;
  const artifact = asRow(
    host.db
      .prepare(
        "SELECT relative_path FROM artifacts WHERE run_id = ? AND artifact_id = ? AND kind = 'receipt'",
      )
      .get(runId, artifactId),
  );
  if (!artifact) return undefined;
  try {
    const raw = readFileSync(
      path.join(
        runWorkDir(host.workspace.rootPath, runId),
        requiredText(artifact, "relative_path"),
        "validate-report.json",
      ),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { mechanical?: unknown };
    return MechanicalReportSchema.parse(parsed.mechanical);
  } catch {
    return undefined;
  }
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
    opts.feedback?.trim().slice(0, 4_000) || `Repair (round ${opts.round}): address sealed defects`;
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
  return evaluationPolicyFromAcceptance(WikiRunSpecAcceptanceSchema.parse(acceptance ?? {}));
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
        `SELECT current.node_key, current.detail_json
         FROM nodes AS current
         JOIN (
           SELECT node_key, MAX(generation) AS generation
           FROM nodes
           WHERE run_id = ? AND node_key LIKE 'repair.%'
           GROUP BY node_key
         ) AS latest
           ON latest.node_key = current.node_key AND latest.generation = current.generation
         WHERE current.run_id = ? AND current.detail_json IS NOT NULL`,
      )
      .all(runId, runId),
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
  /** Only the explicit continue_evaluation command may extend an exhausted model budget. */
  allowExhaustedBudget?: boolean;
};

/**
 * Repair requests name their baseline by candidate identity. Reject stale or
 * malformed declarations while scheduling so a ready repair can never fall
 * back to an unrelated wiki_tree during claim.
 */
function assertSealedRepairBaseline(
  host: Pick<RepairScheduleHost, "db">,
  runId: string,
  candidateId: string,
): void {
  if (!candidateId || candidateId === "pending") {
    throw new Error("repair requires a resolved baseline candidate");
  }
  const candidate = wikiCandidateById(host, runId, candidateId);
  if (!candidate) {
    throw new Error(`repair baseline candidate is unavailable: ${candidateId}`);
  }
  const artifact = asRow(
    host.db
      .prepare(
        `SELECT artifact_id FROM artifacts
         WHERE run_id = ? AND artifact_id = ? AND kind = 'wiki_tree'`,
      )
      .get(runId, candidate.artifactId),
  );
  if (!artifact) {
    throw new Error(`repair baseline candidate is not a sealed wiki_tree: ${candidateId}`);
  }
}

/**
 * Insert `repair.N`, wire edges, hold publication path until EvaluationRound re-runs.
 * Single product entry for mechanical auto-repair and operator/council fix.
 */
export function scheduleRepair(host: RepairScheduleHost, input: ScheduleRepairInput): string {
  const policy = loadEvaluationPolicy(host, input.runId);
  assertUnderMaxCandidates(host, input.runId, policy.maxCandidates);

  const sources = input.repairRequest.sources;
  const needsMechanical = sources.includes("mechanical");
  const needsSemantic = sources.includes("semantic") || sources.includes("operator");

  if (needsMechanical) {
    const budget = policy.mechanical.modelRepairBudget;
    const prior = countRepairsBySource(host, input.runId, "mechanical");
    if (!input.allowExhaustedBudget && (budget <= 0 || prior >= budget)) {
      throw new Error(`mechanical repair budget exhausted or zero (${prior}/${budget})`);
    }
  }
  if (needsSemantic) {
    const budget = policy.semantic.modelRepairBudget;
    const prior = countRepairsBySource(host, input.runId, "semantic");
    if (!input.allowExhaustedBudget && (budget <= 0 || prior >= budget)) {
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
  const baselineCandidateId = baseline?.trim() ?? "";
  assertSealedRepairBaseline(host, input.runId, baselineCandidateId);

  const repairRequest = RepairRequestSchema.parse({
    ...input.repairRequest,
    round,
    baselineCandidateId,
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
  contractForNode("repair", key);

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
        host.applyRerunAt(input.runId, input.failedValidateKey, g, undefined, { selfOnly: true });
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
  const prior = countRepairsBySource(host, command.runId, "semantic");
  if (budget <= 0 || prior >= budget) {
    const recovery = openSemanticEvaluationRecovery(host, command.runId, budget, prior, timestamp);
    if (recovery) return;
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
export function rearmEvaluationRoundAfterRepair(host: RepairScheduleHost, runId: string): void {
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
  mechanicalReportArtifactId?: string,
): boolean {
  if (currentWriteRootGeneration(host, claim.runId) === undefined) return false;

  const policy = loadEvaluationPolicy(host, claim.runId);
  const budget = policy.mechanical.modelRepairBudget;
  const prior = countRepairsBySource(host, claim.runId, "mechanical");
  if (budget <= 0 || prior >= budget) return false;
  if (countModelWikiCandidates(host, claim.runId) >= policy.maxCandidates) return false;

  const round = countRepairs(host, claim.runId) + 1;
  const baseline = latestWikiCandidate(host, claim.runId);
  const feedback = [`Mechanical repair (round ${round}/${budget}):`, message].join("\n");
  const mechanicalReport = loadMechanicalReport(host, claim.runId, mechanicalReportArtifactId);
  const repairRequest = buildMechanicalRepairRequest({
    runId: claim.runId,
    round,
    validationMessage: message,
    baselineCandidateId: baseline?.candidateId,
    mechanicalReport,
    mechanicalReportArtifactId,
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

/**
 * Persist an operator-continuable evaluation recovery only after the mechanical
 * model budget is exhausted. Candidate caps remain hard terminal boundaries.
 */
export function openMechanicalEvaluationRecovery(
  host: RepairScheduleHost,
  claim: ClaimedNode,
  message: string,
  failureClass: string | PiAttemptFailureClass | undefined,
  mechanicalReportArtifactId: string | undefined,
): string | undefined {
  if (!AUTO_MECHANICAL_REPAIR_KINDS.has(claim.kind)) return undefined;
  if (failureClass !== "schema" || !mechanicalReportArtifactId) return undefined;
  const policy = loadEvaluationPolicy(host, claim.runId);
  if (policy.onExhausted !== "operator") return undefined;
  if (countModelWikiCandidates(host, claim.runId) >= policy.maxCandidates) return undefined;

  const used = countRepairsBySource(host, claim.runId, "mechanical");
  const budget = policy.mechanical.modelRepairBudget;
  if (budget > 0 && used < budget) return undefined;

  const report = loadMechanicalReport(host, claim.runId, mechanicalReportArtifactId);
  const candidate = latestWikiCandidate(host, claim.runId);
  if (!report || !candidate) return undefined;

  const prior = asRow(
    host.db
      .prepare(
        `SELECT recovery_id FROM evaluation_recoveries
         WHERE run_id = ? AND state IN ('open', 'continued')
         LIMIT 1`,
      )
      .get(claim.runId),
  );
  if (prior) return undefined;

  const round = countRepairs(host, claim.runId) + 1;
  const repairRequest = buildMechanicalRepairRequest({
    runId: claim.runId,
    round,
    validationMessage: message,
    baselineCandidateId: candidate.candidateId,
    mechanicalReport: report,
    mechanicalReportArtifactId,
  });
  const recoveryId = `evaluation:${claim.runId}:${round}:${mechanicalReportArtifactId.slice(-12)}`;
  const createdAt = now();
  host.db
    .prepare(
      `INSERT INTO evaluation_recoveries (
         recovery_id, run_id, state, source, candidate_id, report_artifact_id,
         repair_request_json, reason, created_at, continued_at
       ) VALUES (?, ?, 'open', 'mechanical', ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      recoveryId,
      claim.runId,
      candidate.candidateId,
      mechanicalReportArtifactId,
      JSON.stringify(repairRequest),
      `mechanical repair budget exhausted (${used}/${budget})`,
      createdAt,
    );
  return recoveryId;
}

/**
 * Semantic exhaustion happens while resolving gate.fix, before a repair node
 * exists to fail. Persist the same terminal recovery record as mechanical
 * validation so the next repair is an explicit, one-time operator command.
 */
function openSemanticEvaluationRecovery(
  host: RepairScheduleHost,
  runId: string,
  budget: number,
  used: number,
  timestamp: string,
): string | undefined {
  const policy = loadEvaluationPolicy(host, runId);
  if (policy.onExhausted !== "operator") return undefined;
  if (countModelWikiCandidates(host, runId) >= policy.maxCandidates) return undefined;
  const existing = asRow(
    host.db
      .prepare(
        `SELECT recovery_id FROM evaluation_recoveries
         WHERE run_id = ? AND state IN ('open', 'continued') LIMIT 1`,
      )
      .get(runId),
  );
  if (existing) return undefined;

  const candidate = latestWikiCandidate(host, runId);
  const report = asRow(
    host.db
      .prepare(
        `SELECT node_outputs.artifact_id
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'review.reduce'
           AND node_outputs.role = 'defects'
           AND artifacts.kind = 'receipt'
         ORDER BY node_outputs.node_generation DESC
         LIMIT 1`,
      )
      .get(runId),
  );
  if (!candidate || !report) return undefined;

  const round = countRepairs(host, runId) + 1;
  const repairRequest = buildSemanticRepairRequest({
    runId,
    round,
    source: "semantic",
    baselineCandidateId: candidate.candidateId,
  });
  const reportArtifactId = requiredText(report, "artifact_id");
  const recoveryId = `evaluation:${runId}:${round}:${reportArtifactId.slice(-12)}`;
  host.db
    .prepare(
      `INSERT INTO evaluation_recoveries (
         recovery_id, run_id, state, source, candidate_id, report_artifact_id,
         repair_request_json, reason, created_at, continued_at
       ) VALUES (?, ?, 'open', 'semantic', ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      recoveryId,
      runId,
      candidate.candidateId,
      reportArtifactId,
      JSON.stringify(repairRequest),
      `semantic repair budget exhausted (${used}/${budget})`,
      timestamp,
    );
  host.db
    .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
    .run(timestamp, runId);
  host.emit(runId, "evaluation.recovery_available");
  return recoveryId;
}

/** Resume exactly one persisted recovery as the next repair.N in the same Run. */
export function continueEvaluationRecovery(
  host: RepairScheduleHost,
  command: { runId: string; recoveryId: string; feedback?: string },
): number {
  const run = asRow(
    host.db.prepare("SELECT state, cancel_requested FROM runs WHERE run_id = ?").get(command.runId),
  );
  if (!run) throw new Error(`run not found: ${command.runId}`);
  if (requiredNumber(run, "cancel_requested") === 1) {
    throw new Error("cannot continue evaluation on a cancelled run");
  }
  if (requiredText(run, "state") !== "failed") {
    throw new Error("continue_evaluation requires a failed run");
  }
  const recovery = asRow(
    host.db
      .prepare(
        `SELECT source, candidate_id, report_artifact_id, repair_request_json
         FROM evaluation_recoveries
         WHERE recovery_id = ? AND run_id = ? AND state = 'open'`,
      )
      .get(command.recoveryId, command.runId),
  );
  if (!recovery) throw new Error("evaluation recovery is stale or unavailable");
  const source = requiredText(recovery, "source");
  if (source !== "mechanical" && source !== "semantic")
    throw new Error("unsupported evaluation recovery source");

  const repairRequest = RepairRequestSchema.parse(
    JSON.parse(requiredText(recovery, "repair_request_json")),
  );
  const candidate = latestWikiCandidate(host, command.runId);
  if (!candidate || candidate.candidateId !== requiredText(recovery, "candidate_id")) {
    throw new Error("evaluation recovery candidate is no longer available");
  }
  const reportArtifactId = requiredText(recovery, "report_artifact_id");
  if (source === "mechanical" && !loadMechanicalReport(host, command.runId, reportArtifactId))
    throw new Error("evaluation recovery report is unavailable");
  if (source === "semantic") {
    const report = asRow(
      host.db
        .prepare(
          `SELECT 1 AS present FROM node_outputs
           JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
           WHERE node_outputs.run_id = ?
             AND node_outputs.node_key = 'review.reduce'
             AND node_outputs.role = 'defects'
             AND node_outputs.artifact_id = ?
             AND artifacts.kind = 'receipt'`,
        )
        .get(command.runId, reportArtifactId),
    );
    if (!report) throw new Error("evaluation recovery report is unavailable");
  }

  const feedback =
    command.feedback?.trim() ||
    `Operator continuation: address the sealed evaluation report for ${repairRequest.baselineCandidateId}`;
  scheduleRepair(host, {
    runId: command.runId,
    repairRequest,
    feedback,
    wikiUpstreamKey: source === "mechanical" ? "write.root" : "review.reduce",
    autoRepair: false,
    allowExhaustedBudget: true,
  });
  host.db
    .prepare(
      `UPDATE evaluation_recoveries SET state = 'continued', continued_at = ?
       WHERE recovery_id = ? AND run_id = ? AND state = 'open'`,
    )
    .run(now(), command.recoveryId, command.runId);
  unlockReadyNodes(host, command.runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(now(), command.runId);
  return host.emit(command.runId, "node.ready");
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
  if (
    countRepairsBySource(host, claim.runId, "mechanical") >= policy.mechanical.modelRepairBudget
  ) {
    return false;
  }
  if (countModelWikiCandidates(host, claim.runId) >= policy.maxCandidates) return false;

  return true;
}

/** Feedback prefix for auto mechanical repair rounds (detail / tests). */
export const MECHANICAL_REPAIR_FEEDBACK_PREFIX = "Mechanical repair (";
