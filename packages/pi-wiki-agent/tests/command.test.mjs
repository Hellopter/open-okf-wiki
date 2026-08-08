import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWikiHelp,
  getWikiArgumentCompletions,
  parseWikiCommand,
  WikiCommandError,
} from "../dist/command.js";

test("parses generate, approve, controls, sources, and free-text focus", () => {
  assert.deepEqual(parseWikiCommand("generate authentication model"), { action: "generate", focus: "authentication model" });
  assert.deepEqual(parseWikiCommand("approve run-42"), { action: "approve", runId: "run-42" });
  assert.deepEqual(parseWikiCommand("resume run-42"), { action: "resume", workflowRunId: "run-42" });
  assert.deepEqual(parseWikiCommand("repository architecture"), { action: "generate", focus: "repository architecture" });
  assert.deepEqual(parseWikiCommand("source add path ../service --id service"), {
    action: "source-add-link", path: "../service", id: "service",
  });
  assert.deepEqual(parseWikiCommand("status --json"), { action: "status" });
});

test("rejects malformed and unsupported commands", () => {
  for (const command of ["run", "--plan", "--write", "restart", "retry"]) {
    assert.throws(() => parseWikiCommand(command), /Unknown subcommand/);
  }
  assert.throws(() => parseWikiCommand("approve a b"), WikiCommandError);
  assert.throws(() => parseWikiCommand("source add clone"), WikiCommandError);
  assert.throws(() => parseWikiCommand("init --lang ja"), WikiCommandError);
});

test("help and completions expose only the current workflow", () => {
  const help = formatWikiHelp();
  assert.match(help, /\/wiki generate/);
  assert.match(help, /\/wiki approve/);
  assert.match(help, /run-scoped main-agent session/);
  const values = getWikiArgumentCompletions("").map((item) => item.value);
  assert.ok(values.includes("generate"));
  assert.ok(values.includes("approve"));
  assert.ok(!values.includes("run"));
});
