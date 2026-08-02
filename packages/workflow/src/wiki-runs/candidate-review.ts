/** Candidate review owns safe candidate reads, diffing, anchors, and repair batches. */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CandidateDiffRead,
  CandidatePageRead,
  CandidateTreeRead,
  CreateReviewThreadCommand,
  RequestRepairCommand,
  ResolveReviewThreadCommand,
  RunCommandContext,
  RunCommandReceipt,
} from "@okf-wiki/contract";
import {
  CandidateDiffReadSchema,
  CandidatePageReadSchema,
  CandidateTreeReadSchema,
  RepairRequestSchema,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import type { CommandsHost } from "./commands.js";
import { digest, now } from "./crypto-util.js";
import type { WikiRunsDbCtx } from "./ctx.js";
import { scheduleRepair } from "./repair-schedule.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";
import { WikiRunsRequestError } from "./types.js";

type CandidateRecord = {
  artifactId: string;
  candidateId: string;
  digest: string;
  relativePath: string;
};

type CandidateEvidenceMap = {
  version: 1;
  candidateDigest: string;
  pages: Array<{
    pagePath: string;
    contentDigest: string;
    evidence: CandidatePageRead["evidence"];
  }>;
};

/** Read-only candidate inspection surface. It deliberately excludes all command callbacks. */
export type CandidateReadHost = Pick<WikiRunsDbCtx, "db" | "workspace">;

/** Narrow write surface retained only by review-thread and repair commands. */
type CandidateReviewCommandHost = CandidateReadHost &
  Pick<WikiRunsDbCtx, "emit"> &
  Pick<CommandsHost, "currentNodeGeneration" | "applyRerunAt">;

function assertPagePath(pagePath: string): string {
  const value = pagePath.trim();
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new WikiRunsRequestError("invalid_request", "candidate page path is invalid");
  }
  return value;
}

function candidateForDigest(
  host: Pick<CandidateReadHost, "db">,
  runId: string,
  digestValue: string,
): CandidateRecord {
  const row = asRow(
    host.db
      .prepare(
        `SELECT wiki_candidates.candidate_id, wiki_candidates.digest, wiki_candidates.artifact_id,
                artifacts.relative_path
         FROM wiki_candidates
         JOIN artifacts ON artifacts.artifact_id = wiki_candidates.artifact_id
         WHERE wiki_candidates.run_id = ? AND wiki_candidates.digest = ? AND artifacts.kind = 'wiki_tree'
         ORDER BY wiki_candidates.round DESC LIMIT 1`,
      )
      .get(runId, digestValue),
  );
  if (!row) throw new WikiRunsRequestError("not_found", "candidate is unavailable");
  return {
    candidateId: requiredText(row, "candidate_id"),
    digest: requiredText(row, "digest"),
    artifactId: requiredText(row, "artifact_id"),
    relativePath: requiredText(row, "relative_path"),
  };
}

function candidateRoot(host: CandidateReadHost, runId: string, candidate: CandidateRecord): string {
  const runRoot = path.resolve(runWorkDir(host.workspace.rootPath, runId));
  const root = path.resolve(runRoot, candidate.relativePath);
  if (path.relative(runRoot, root).startsWith("..") || path.relative(runRoot, root) === "") {
    throw new WikiRunsRequestError("not_found", "candidate is unavailable");
  }
  return root;
}

function candidatePagePath(
  host: CandidateReadHost,
  runId: string,
  candidate: CandidateRecord,
  pagePath: string,
): string {
  const root = candidateRoot(host, runId, candidate);
  const file = path.resolve(root, assertPagePath(pagePath));
  if (path.relative(root, file).startsWith("..") || path.relative(root, file) === "") {
    throw new WikiRunsRequestError(
      "invalid_request",
      "candidate page path escapes its sealed tree",
    );
  }
  if (!existsSync(file))
    throw new WikiRunsRequestError("not_found", "candidate page is unavailable");
  return file;
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function selectedTextDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function evidenceMapForCandidate(
  host: CandidateReadHost,
  runId: string,
  candidate: CandidateRecord,
): CandidateEvidenceMap {
  const row = asRow(
    host.db
      .prepare(
        `SELECT candidate_review_artifacts.evidence_digest, artifacts.relative_path
         FROM candidate_review_artifacts
         JOIN artifacts ON artifacts.artifact_id = candidate_review_artifacts.evidence_artifact_id
         WHERE candidate_review_artifacts.run_id = ?
           AND candidate_review_artifacts.candidate_digest = ?
           AND artifacts.kind = 'evidence_map'`,
      )
      .get(runId, candidate.digest),
  );
  if (!row) throw new WikiRunsRequestError("not_found", "candidate evidence map is unavailable");
  const runRoot = path.resolve(runWorkDir(host.workspace.rootPath, runId));
  const mapPath = path.resolve(runRoot, requiredText(row, "relative_path"), "evidence-map.json");
  if (path.relative(runRoot, mapPath).startsWith("..")) {
    throw new WikiRunsRequestError("not_found", "candidate evidence map is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    throw new WikiRunsRequestError("not_found", "candidate evidence map is unavailable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WikiRunsRequestError("conflict", "candidate evidence map is invalid");
  }
  const map = parsed as CandidateEvidenceMap;
  if (
    map.version !== 1 ||
    map.candidateDigest !== candidate.digest ||
    !Array.isArray(map.pages) ||
    digest(map) !== requiredText(row, "evidence_digest")
  ) {
    throw new WikiRunsRequestError("conflict", "candidate evidence map is invalid");
  }
  for (const page of map.pages) {
    if (
      !page ||
      typeof page.pagePath !== "string" ||
      typeof page.contentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(page.contentDigest) ||
      !Array.isArray(page.evidence)
    ) {
      throw new WikiRunsRequestError("conflict", "candidate evidence map is invalid");
    }
    assertPagePath(page.pagePath);
  }
  return map;
}

function sealedPage(
  host: CandidateReadHost,
  runId: string,
  candidate: CandidateRecord,
  pagePath: string,
): { content: string; evidence: CandidatePageRead["evidence"] } {
  const map = evidenceMapForCandidate(host, runId, candidate);
  const entry = map.pages.find((page) => page.pagePath === pagePath);
  if (!entry) throw new WikiRunsRequestError("not_found", "candidate page is unavailable");
  const content = readFileSync(candidatePagePath(host, runId, candidate, pagePath), "utf8");
  if (contentDigest(content) !== entry.contentDigest) {
    throw new WikiRunsRequestError(
      "conflict",
      "candidate page no longer matches its sealed evidence map",
    );
  }
  return { content, evidence: entry.evidence };
}

function lineDiff(before: string, after: string): CandidateDiffRead["lines"] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const rows: CandidateDiffRead["lines"] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i += 1) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine && oldLine !== undefined) {
      rows.push({ kind: "context", oldLine: i + 1, newLine: i + 1, text: oldLine });
    } else {
      if (oldLine !== undefined) rows.push({ kind: "remove", oldLine: i + 1, text: oldLine });
      if (newLine !== undefined) rows.push({ kind: "add", newLine: i + 1, text: newLine });
    }
  }
  return rows;
}

function recordCommand(
  host: CandidateReviewCommandHost,
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

/** Deep module boundary for all candidate/read review behavior. */
export class CandidateReview {
  constructor(protected readonly host: CandidateReadHost) {}

  readPage(input: { runId: string; candidateDigest: string; pagePath: string }): CandidatePageRead {
    const pagePath = assertPagePath(input.pagePath);
    const candidate = candidateForDigest(this.host, input.runId, input.candidateDigest);
    const page = sealedPage(this.host, input.runId, candidate, pagePath);
    return CandidatePageReadSchema.parse({
      runId: input.runId,
      candidateDigest: candidate.digest,
      pagePath,
      content: page.content,
      evidence: page.evidence,
    });
  }

  readTree(input: { runId: string; candidateDigest: string }): CandidateTreeRead {
    const candidate = candidateForDigest(this.host, input.runId, input.candidateDigest);
    return CandidateTreeReadSchema.parse({
      runId: input.runId,
      candidateDigest: candidate.digest,
      pages: evidenceMapForCandidate(this.host, input.runId, candidate).pages.map(
        (page) => page.pagePath,
      ),
    });
  }

  readDiff(input: { runId: string; candidateDigest: string; pagePath: string }): CandidateDiffRead {
    const pagePath = assertPagePath(input.pagePath);
    const candidate = candidateForDigest(this.host, input.runId, input.candidateDigest);
    const page = this.readPage({ ...input, pagePath });
    const baseline = asRow(
      this.host.db
        .prepare(
          `SELECT baseline_digest FROM candidate_review_artifacts
           WHERE run_id = ? AND candidate_digest = ?`,
        )
        .get(input.runId, candidate.digest),
    );
    const baselineDigest = baseline ? requiredText(baseline, "baseline_digest") : candidate.digest;
    let before = "";
    try {
      const parent = candidateForDigest(this.host, input.runId, baselineDigest);
      before = sealedPage(this.host, input.runId, parent, pagePath).content;
    } catch {
      // First candidate or a new page: an empty baseline is the meaningful diff.
    }
    return CandidateDiffReadSchema.parse({
      runId: input.runId,
      candidateDigest: candidate.digest,
      pagePath: page.pagePath,
      baselineDigest,
      lines: lineDiff(before, page.content),
    });
  }
}

/** Command-side companion. Read paths never instantiate this wider host. */
export class CandidateReviewCommands extends CandidateReview {
  constructor(private readonly commandHost: CandidateReviewCommandHost) {
    super(commandHost);
  }

  createThread(
    command: CreateReviewThreadCommand,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    const page = this.readPage({
      runId: command.runId,
      candidateDigest: command.anchor.candidateDigest,
      pagePath: command.anchor.pagePath,
    });
    const lines = splitLines(page.content);
    if (command.anchor.endLine > lines.length)
      throw new WikiRunsRequestError("conflict", "review anchor is outside the candidate page");
    const selected = lines.slice(command.anchor.startLine - 1, command.anchor.endLine).join("\n");
    const digest = selectedTextDigest(selected);
    if (command.anchor.selectedTextDigest && digest !== command.anchor.selectedTextDigest) {
      throw new WikiRunsRequestError(
        "conflict",
        "review anchor no longer matches the sealed candidate text",
      );
    }
    const timestamp = now();
    const threadId = randomUUID();
    this.commandHost.db
      .prepare(
        `INSERT INTO review_threads (
          thread_id, run_id, candidate_digest, page_path, start_line, end_line,
          selected_text_digest, body, state, author_id, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL)`,
      )
      .run(
        threadId,
        command.runId,
        command.anchor.candidateDigest,
        command.anchor.pagePath,
        command.anchor.startLine,
        command.anchor.endLine,
        digest,
        command.body,
        context.actor.id,
        timestamp,
      );
    const revision = this.commandHost.emit(command.runId, "review_thread.created");
    recordCommand(
      this.commandHost,
      command.commandId,
      payloadDigest,
      context,
      command.runId,
      revision,
    );
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
  }

  resolveThread(
    command: ResolveReviewThreadCommand,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    const timestamp = now();
    const result = this.commandHost.db
      .prepare(
        `UPDATE review_threads SET state = 'resolved', resolved_at = ?
         WHERE thread_id = ? AND run_id = ? AND state = 'open'`,
      )
      .run(timestamp, command.threadId, command.runId) as { changes?: number };
    if ((result.changes ?? 0) !== 1)
      throw new WikiRunsRequestError("conflict", "review thread is stale or unavailable");
    const revision = this.commandHost.emit(command.runId, "review_thread.resolved");
    recordCommand(
      this.commandHost,
      command.commandId,
      payloadDigest,
      context,
      command.runId,
      revision,
    );
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
  }

  requestRepair(
    command: RequestRepairCommand,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    const placeholders = command.threadIds.map(() => "?").join(", ");
    const rows = asRows(
      this.commandHost.db
        .prepare(
          `SELECT thread_id, candidate_digest, page_path, start_line, end_line, body
           FROM review_threads
           WHERE run_id = ? AND state = 'open' AND thread_id IN (${placeholders})`,
        )
        .all(command.runId, ...command.threadIds),
    );
    if (rows.length !== command.threadIds.length)
      throw new WikiRunsRequestError("conflict", "repair request includes a stale review thread");
    const candidateDigest = requiredText(rows[0]!, "candidate_digest");
    if (rows.some((row) => requiredText(row, "candidate_digest") !== candidateDigest)) {
      throw new WikiRunsRequestError("conflict", "one repair request must target one candidate");
    }
    const candidate = candidateForDigest(this.host, command.runId, candidateDigest);
    const pages = [...new Set(rows.map((row) => requiredText(row, "page_path")))];
    const issues = rows.map((row) => ({
      kind: "operator" as const,
      threadId: requiredText(row, "thread_id"),
      pagePath: requiredText(row, "page_path"),
      startLine: requiredNumber(row, "start_line"),
      endLine: requiredNumber(row, "end_line"),
      message: requiredText(row, "body"),
    }));
    const round = requiredNumber(
      asRow(
        this.commandHost.db
          .prepare("SELECT COUNT(*) + 1 AS round FROM nodes WHERE run_id = ? AND kind = 'repair'")
          .get(command.runId),
      ) ?? {},
      "round",
    );
    const repairRequest = RepairRequestSchema.parse({
      requestId: `repair:operator:${command.runId}:${round}`,
      baselineCandidateId: candidate.candidateId,
      round,
      sources: ["operator"],
      issues,
      scope: { pages, mode: "patch" },
    });
    const wikiUpstream = asRow(
      this.commandHost.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = 'review.reduce' LIMIT 1",
        )
        .get(command.runId),
    )
      ? "review.reduce"
      : "write.root";
    scheduleRepair(this.commandHost, {
      runId: command.runId,
      repairRequest,
      feedback: rows.map((row) => requiredText(row, "body")).join("\n\n"),
      wikiUpstreamKey: wikiUpstream,
      autoRepair: false,
    });
    const revision = this.commandHost.emit(command.runId, "repair.requested");
    recordCommand(
      this.commandHost,
      command.commandId,
      payloadDigest,
      context,
      command.runId,
      revision,
    );
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
  }
}
