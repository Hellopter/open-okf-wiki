/**
 * Durable scope revision coordination.
 *
 * Scope changes stop claimable work and restart planning under a new explicit
 * Plan Gate. They never mutate an Attempt input in place.
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
import { asRow, requiredNumber, requiredText } from "./sql.js";
import { WikiRunsRequestError } from "./types.js";

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
  if (!run) throw new WikiRunsRequestError("not_found", `run not found: ${runId}`);
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

export function submitRunRevision(
  host: CommandsHost,
  command: SubmitRunRevisionCommand,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const run = activeRun(host, command.runId);
  if (isTerminal(run.state)) {
    throw new WikiRunsRequestError("conflict", `cannot revise a terminal run: ${run.state}`);
  }
  const timestamp = now();
  const revisionId = randomUUID();

  host.db
    .prepare(
      `INSERT INTO run_revisions (
        revision_id, run_id, kind, content, command_id, actor_id, created_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revisionId,
      command.runId,
      command.kind,
      command.content,
      command.commandId,
      context.actor.id,
      timestamp,
      timestamp,
    );

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
  const revision = host.emit(command.runId, "revision.applied");
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
    throw new WikiRunsRequestError("conflict", `cannot pause run in state: ${run.state}`);
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
  if (run.state !== "paused") {
    throw new WikiRunsRequestError("conflict", `cannot resume run in state: ${run.state}`);
  }
  const timestamp = now();
  host.db
    .prepare("UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ?")
    .run(timestamp, command.runId);
  const revision = host.emit(command.runId, "run.resumed");
  recordCommand(host, command.commandId, payloadDigest, context, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}
