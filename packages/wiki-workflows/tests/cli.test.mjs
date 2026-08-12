import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWikiCliCommand,
  renderWikiEvent,
  renderWikiRun,
  renderWikiRuns,
  renderWikiContextStats,
  renderWikiTask,
  renderWikiTaskProcess,
  wikiCliHelp,
} from "../dist/cli.js";

test("parses the compact Wiki command surface", () => {
  assert.deepEqual(parseWikiCliCommand(""), { action: "run", regenerate: false });
  assert.deepEqual(parseWikiCliCommand("auth and sessions"), {
    action: "run",
    regenerate: false,
    focus: "auth and sessions",
  });
  assert.deepEqual(parseWikiCliCommand('regenerate "public API"'), {
    action: "run",
    regenerate: true,
    focus: "public API",
  });
  assert.deepEqual(parseWikiCliCommand("status run-1"), { action: "status", runId: "run-1" });
  assert.deepEqual(parseWikiCliCommand("runs"), { action: "runs" });
  assert.deepEqual(parseWikiCliCommand("pause"), { action: "pause" });
  assert.deepEqual(parseWikiCliCommand("resume"), { action: "resume" });
  assert.deepEqual(parseWikiCliCommand("cancel run.2"), { action: "cancel", runId: "run.2" });
  assert.deepEqual(parseWikiCliCommand("init"), {
    action: "init", language: "zh", exclude: [], defaultSourceIgnores: true,
  });
  assert.deepEqual(parseWikiCliCommand('init docs --lang en --exclude "vendor/**" --exclude generated/** --no-default-ignores'), {
    action: "init", workspace: "docs", language: "en", exclude: ["vendor/**", "generated/**"], defaultSourceIgnores: false,
  });
  assert.deepEqual(parseWikiCliCommand("source add link ../api --name backend --workspace docs"), {
    action: "source-add", kind: "link", localPath: "../api", name: "backend", workspace: "docs",
  });
  assert.deepEqual(parseWikiCliCommand("source add clone https://example.test/web.git --ref main --name web"), {
    action: "source-add", kind: "clone", url: "https://example.test/web.git", ref: "main", name: "web",
  });
});

test("rejects ambiguous control commands", () => {
  assert.throws(() => parseWikiCliCommand("runs extra"), /does not accept arguments/);
  assert.throws(() => parseWikiCliCommand("resume one two"), /Usage/);
  assert.throws(() => parseWikiCliCommand("status ../run"), /Invalid Wiki run id/);
  assert.throws(() => parseWikiCliCommand("init a b"), /Usage/);
  assert.throws(() => parseWikiCliCommand("init --lang fr"), /zh or en/);
  assert.throws(() => parseWikiCliCommand("init --exclude"), /requires a value/);
  assert.throws(() => parseWikiCliCommand("source add link ../api --ref main"), /Unknown/);
  assert.throws(() => parseWikiCliCommand("source add clone"), /Usage/);
});

test("renders plain run, list, and progress output", () => {
  assert.equal(renderWikiRun(undefined), "Wiki: no run.");
  assert.equal(renderWikiRun({
    id: "run-1",
    cwd: "/repo",
    operation: "update",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    lastEventSequence: 1,
  }), "Wiki run-1 | update | running | auth");
  assert.equal(renderWikiRuns([]), "Wiki runs: none.");
  assert.match(renderWikiRuns([{ id: "run-1", status: "paused", updatedAt: "2026-08-12" }]), /run-1 \| paused/);
  assert.equal(renderWikiEvent({
    version: 1,
    runId: "run-1",
    sequence: 2,
    at: "2026-08-12T00:00:00.000Z",
    type: "progress",
    message: "Wrote auth/domain.md",
    data: { stage: "write", completed: 3, total: 4 },
  }), "[write 3/4] Wrote auth/domain.md");
  assert.equal(renderWikiEvent({
    version: 1,
    runId: "run-1",
    sequence: 3,
    at: "2026-08-12T00:00:00.000Z",
    type: "paused",
    message: "Wiki run paused",
  }), "Wiki run paused");
});

test("help lists management and run commands", () => {
  const help = wikiCliHelp();
  assert.match(help, /\/wiki \[focus\]/);
  assert.match(help, /\/wiki regenerate/);
  assert.match(help, /\/wiki init/);
  assert.match(help, /\/wiki source add link/);
  assert.match(help, /\/wiki source add clone/);
  assert.match(help, /\/wiki status \[run-id\] \[task-id\] \[--process\]/);
  assert.doesNotMatch(help, /open|history|artifacts|stop/);
});

test("parses status with task id and process flag", () => {
  assert.deepEqual(parseWikiCliCommand("status"), { action: "status" });
  assert.deepEqual(parseWikiCliCommand("status run-1"), { action: "status", runId: "run-1" });
  assert.deepEqual(parseWikiCliCommand("status run-1 task-9"), {
    action: "status", runId: "run-1", taskId: "task-9",
  });
  assert.deepEqual(parseWikiCliCommand("status run-1 task-9 --process"), {
    action: "status", runId: "run-1", taskId: "task-9", process: true,
  });
  assert.deepEqual(parseWikiCliCommand("status --process run-1 task-9"), {
    action: "status", runId: "run-1", taskId: "task-9", process: true,
  });
  assert.deepEqual(parseWikiCliCommand("status run-1 --process task-9"), {
    action: "status", runId: "run-1", taskId: "task-9", process: true,
  });
});

test("rejects status --process without a task id and invalid task ids", () => {
  const usage = /Usage: \/wiki status \[run-id\] \[task-id\] \[--process\]/;
  assert.throws(() => parseWikiCliCommand("status --process"), usage);
  assert.throws(() => parseWikiCliCommand("status run-1 --process"), usage);
  assert.throws(() => parseWikiCliCommand("status run-1 task-9 extra"), usage);
  assert.throws(() => parseWikiCliCommand("status ../task"), /Invalid Wiki run id/);
  assert.throws(() => parseWikiCliCommand("status run-1 ../task"), /Invalid Wiki task id/);
});

test("renders a progress card with stage, batch, and task icons", () => {
  const rendered = renderWikiRun({
    id: "run-1",
    cwd: "/repo",
    operation: "update",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:04:12.000Z",
    lastEventSequence: 4,
    progress: {
      stage: "write",
      batch: 2,
      completed: 3,
      total: 4,
      lastMessage: "Wrote auth/domain.md",
      tasks: [
        { role: "research", id: "t1", status: "complete", attempts: 1 },
        { role: "write", id: "t2", status: "running", attempts: 2 },
        { role: "review", id: "t3", status: "queued" },
        { role: "write", id: "t4", status: "failed", attempts: 1 },
        { role: "review", id: "t5", status: "incomplete" },
      ],
    },
  });
  assert.match(rendered, /Wiki run-1  update  running  \[4m12s\]/);
  assert.match(rendered, /stage  write · batch 2  ·  3\/4 done, 1 running/);
  assert.match(rendered, /focus  auth/);
  assert.match(rendered, /✓ research  t1  \[attempt 1\]/);
  assert.match(rendered, /◆ write  t2  \[attempt 2\]/);
  assert.match(rendered, /· review  t3/);
  assert.match(rendered, /✗ write  t4  \[attempt 1\]/);
  assert.match(rendered, /◐ review  t5/);
  assert.match(rendered, /last  Wrote auth\/domain\.md/);
});

test("renders a task result dossier with summary and truncated handoff", () => {
  const handoffBody = Array.from({ length: 82 }, (_, index) => `line ${index + 1}`).join("\n");
  const rendered = renderWikiTask({
    runId: "run-1",
    task: {
      id: "task-9",
      role: "write",
      status: "complete",
      attempts: 2,
      summary: "task-level",
      startedAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:48.000Z",
    },
    receipt: {
      id: "task-9",
      role: "write",
      status: "complete",
      summary: "Wrote the auth domain page",
      outputs: [],
      coverage: ["wiki/auth/domain.md"],
      gaps: [{ question: "How are sessions revoked?" }],
      error: { code: "quota", message: "quota approaching", retryable: false },
      attempts: 2,
    },
    handoffPath: "artifacts/task-9.md",
    handoff: handoffBody,
    processAvailable: false,
  });
  assert.match(rendered, /Wiki run-1  ·  task-9/);
  assert.match(rendered, /write  complete  ·  2 attempts  ·  48s/);
  assert.match(rendered, /summary\n {2}Wrote the auth domain page/);
  assert.match(rendered, /coverage\n {2}wiki\/auth\/domain\.md/);
  assert.match(rendered, /gaps\n {2}How are sessions revoked\?/);
  assert.match(rendered, /error  quota approaching/);
  assert.match(rendered, /handoff  artifacts\/task-9\.md/);
  assert.match(rendered, /line 1/);
  assert.match(rendered, /line 80/);
  assert.doesNotMatch(rendered, /line 81/);
  assert.match(rendered, /handoff continues; \d+ at artifacts\/task-9\.md/);
});

test("renders context stats for a selected task", () => {
  assert.equal(
    renderWikiContextStats({
      turns: 3,
      toolCalls: 4,
      input: 1200,
      output: 620,
      contextTokens: 8100,
      contextWindow: 200_000,
      contextPercent: 4.1,
      cost: 0.012,
    }),
    "3 turns  4 tools  ↑1.2k  ↓620  ctx 8.1k/200k 4%  $0.01",
  );
  const rendered = renderWikiTask({
    runId: "run-1",
    task: { id: "task-9", role: "write", status: "complete" },
    usage: { turns: 1, input: 80, output: 20, contextTokens: 400, contextWindow: 200_000, contextPercent: 0.2 },
    processAvailable: false,
  });
  assert.match(rendered, /context  1 turn  ↑80  ↓20  ctx 400\/200k 0%/);
});

test("renders process dossier as unavailable or history", () => {
  assert.equal(
    renderWikiTaskProcess({
      runId: "run-1",
      task: { id: "task-9", role: "write", status: "complete" },
      processAvailable: false,
      handoffPath: "artifacts/task-9.md",
    }),
    [
      "Wiki run-1  ·  task-9  ·  process",
      "process  unavailable for this task",
      "handoff  artifacts/task-9.md",
    ].join("\n"),
  );
  const withHistory = renderWikiTaskProcess({
    runId: "run-1",
    task: { id: "task-9", role: "write", status: "complete" },
    processAvailable: true,
    history: [
      { role: "user", kind: "text", text: "Write the page" },
      { role: "assistant", kind: "toolCall", toolName: "read", text: "wiki/auth.md" },
      { role: "assistant", kind: "text", text: "Drafting" },
      { role: "tool", kind: "error", text: "timeout" },
    ],
  });
  assert.match(withHistory, /Wiki run-1  ·  task-9  ·  process/);
  assert.match(withHistory, /^user  Write the page$/m);
  assert.match(withHistory, /^→ read  wiki\/auth\.md$/m);
  assert.match(withHistory, /^text  Drafting$/m);
  assert.match(withHistory, /^error  timeout$/m);
});
