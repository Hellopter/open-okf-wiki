/**
 * Durable Run revision and epoch coordination.
 *
 * Guidance waits for a scheduler boundary so a live Attempt never observes
 * changing instructions. Scope changes stop claimable work, supersede the
 * active epoch, and restart planning under a new explicit Plan Gate.
 */

import { randomUUID } from "node:crypto";
import type {
  PauseRunCommand,
  ResumeRunCommand,
  RunCommandContext,
  RunCommandReceipt,
  SubmitRunRevisionCommand,
} from "@okf-wiki/contract";
import type { CommandsHost } from "./commands.js";
import { now } from "./crypto-util.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";

function recordCommand(
  host: CommandsHost,
  commandId: string,
  payloadDigest: string,
  context: RunCommandContext,
  runId: string,
  revision: number,
): void {
  host.db
    .prepare(
      `INSERT INTO commands (
        workspace_id, command_id, payload_digest, actor_id, actor_kind, run_id, revision, accepted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      host.workspace.id,
      commandId,
      payloadDigest,
      context.actor.id,
      context.actor.kind,
      runId,
      revision,
    );
}

function activeRun(host: CommandsHost, runId: string): { state: string; revision: number } {
  const run = asRow(
    host.db.prepare("SELECT state, revision FROM runs WHERE run_id = ?").get(runId),
  );
  if (!run) throw new Error(`run not found: ${runId}`);
  return { state: requiredText(run, "state"), revision: requiredNumber(run, "revision") };
}

function isTerminal(state: string): boolean {
  return [
    "failed",
    "publication_declined",
    "completed_unpublished",
    "published",
    "cancelled",
  ].includes(state);
}

/** Apply all queued guidance only when no model/mechanical attempt is live. */
export function applyPendingGuidanceAtSafeBoundary(host: CommandsHost): void {
  const rows = asRows(
    host.db
      .prepare(
        `SELECT run_revisions.run_id
         FROM run_revisions
         JOIN runs ON runs.run_id = run_revisions.run_id
         WHERE run_revisions.kind = 'guidance' AND run_revisions.applied_at IS NULL
           AND runs.state NOT IN ('paused', 'pausing', 'cancelling', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM attempts
             WHERE attempts.run_id = run_revisions.run_id AND attempts.state = 'running'
           )
         GROUP BY run_revisions.run_id`,
      )
      .all(),
  );
  const timestamp = now();
  for (const row of rows) {
    const runId = requiredText(row, "run_id");
    host.db
      .prepare(
        `UPDATE run_revisions SET applied_at = ?
         WHERE run_id = ? AND kind = 'guidance' AND applied_at IS NULL`,
      )
      .run(timestamp, runId);
    host.emit(runId, "revision.applied");
  }
}

export function submitRunRevision(
  host: CommandsHost,
  command: SubmitRunRevisionCommand,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const run = activeRun(host, command.runId);
  if (isTerminal(run.state)) throw new Error(`cannot revise a terminal run: ${run.state}`);
  const timestamp = now();
  const revisionId = randomUUID();

  host.db
    .prepare(
      `INSERT INTO run_revisions (
        revision_id, run_id, kind, content, command_id, actor_id, created_at, applied_at, epoch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      revisionId,
      command.runId,
      command.kind,
      command.content,
      command.commandId,
      context.actor.id,
      timestamp,
    );

  if (command.kind === "scope_change") {
    const preservePause = run.state === "paused";
    // A scope change never races model work. Abort the disposable workers then
    // retire all current graph work except frozen inputs and the new plan root.
    host.abortRunAttempts(command.runId);
    host.withdrawOpenGates(command.runId);
    host.cancelPreApplyEffects(command.runId);
    host.db
      .prepare(
        `UPDATE attempts SET state = 'suspended', error = 'scope changed', ended_at = ?
         WHERE run_id = ? AND state = 'running'`,
      )
      .run(timestamp, command.runId);
    host.db
      .prepare(
        `UPDATE nodes SET state = 'cancelled', current_attempt_id = NULL
         WHERE run_id = ? AND node_key NOT IN ('freeze', 'plan')
           AND state IN ('blocked', 'ready', 'running', 'waiting', 'invalidated')`,
      )
      .run(command.runId);
    host.db
      .prepare(
        "UPDATE execution_epochs SET state = 'superseded' WHERE run_id = ? AND state = 'active'",
      )
      .run(command.runId);
    const ordinal = requiredNumber(
      asRow(
        host.db
          .prepare(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM execution_epochs WHERE run_id = ?",
          )
          .get(command.runId),
      ) ?? {},
      "ordinal",
    );
    const epochId = randomUUID();
    host.db
      .prepare(
        `INSERT INTO execution_epochs (epoch_id, run_id, ordinal, scope_revision_id, state, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(epochId, command.runId, ordinal, revisionId, timestamp);
    host.db
      .prepare("UPDATE run_revisions SET applied_at = ?, epoch_id = ? WHERE revision_id = ?")
      .run(timestamp, epochId, revisionId);
    const plan = host.currentNodeRow(command.runId, "plan");
    if (!plan) throw new Error("scope change requires a durable plan node");
    host.applyRerunAt(command.runId, "plan", requiredNumber(plan, "generation"), command.content, {
      selfOnly: true,
    });
    if (preservePause) {
      host.db
        .prepare("UPDATE runs SET state = 'paused', updated_at = ? WHERE run_id = ?")
        .run(timestamp, command.runId);
    }
    const revision = host.emit(command.runId, "epoch.created");
    recordCommand(host, command.commandId, payloadDigest, context, command.runId, revision);
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
  }

  const revision = host.emit(command.runId, "revision.submitted");
  recordCommand(host, command.commandId, payloadDigest, context, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

export function pauseRun(
  host: CommandsHost,
  command: PauseRunCommand,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const run = activeRun(host, command.runId);
  if (!["queued", "running", "waiting_for_operator", "pausing"].includes(run.state)) {
    throw new Error(`cannot pause run in state: ${run.state}`);
  }
  const timestamp = now();
  host.db
    .prepare("UPDATE runs SET state = 'pausing', updated_at = ? WHERE run_id = ?")
    .run(timestamp, command.runId);
  host.emit(command.runId, "run.pausing");
  host.abortRunAttempts(command.runId);
  // Resume always claims a new Attempt from the original sealed input envelope.
  host.db
    .prepare(
      `UPDATE attempts SET state = 'suspended', error = 'paused', ended_at = ?
       WHERE run_id = ? AND state = 'running'`,
    )
    .run(timestamp, command.runId);
  host.db
    .prepare(
      `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
       WHERE run_id = ? AND state = 'running'`,
    )
    .run(command.runId);
  host.db
    .prepare("UPDATE runs SET state = 'paused', updated_at = ? WHERE run_id = ?")
    .run(timestamp, command.runId);
  const revision = host.emit(command.runId, "run.paused");
  recordCommand(host, command.commandId, payloadDigest, context, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

export function resumeRun(
  host: CommandsHost,
  command: ResumeRunCommand,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const run = activeRun(host, command.runId);
  if (run.state !== "paused") throw new Error(`cannot resume run in state: ${run.state}`);
  const timestamp = now();
  host.db
    .prepare("UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ?")
    .run(timestamp, command.runId);
  const revision = host.emit(command.runId, "run.resumed");
  recordCommand(host, command.commandId, payloadDigest, context, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}
