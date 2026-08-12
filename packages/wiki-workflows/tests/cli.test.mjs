import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWikiCliCommand,
  renderWikiEvent,
  renderWikiRun,
  renderWikiRuns,
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
});

test("rejects ambiguous control commands", () => {
  assert.throws(() => parseWikiCliCommand("runs extra"), /does not accept arguments/);
  assert.throws(() => parseWikiCliCommand("resume one two"), /Usage/);
  assert.throws(() => parseWikiCliCommand("status ../run"), /Invalid Wiki run id/);
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

test("help lists only the supported commands", () => {
  const help = wikiCliHelp();
  assert.match(help, /\/wiki \[focus\]/);
  assert.match(help, /\/wiki regenerate/);
  assert.doesNotMatch(help, /init|source add|open|history|artifacts|stop/);
});
