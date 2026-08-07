import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWikiHelp,
  getWikiArgumentCompletions,
  parseWikiCommand,
  WikiCommandError,
} from "../dist/command.js";

test("empty /wiki opens the Navigator; help remains explicit", () => {
  assert.deepEqual(parseWikiCommand(""), { action: "open" });
  assert.deepEqual(parseWikiCommand("   "), { action: "open" });
  assert.deepEqual(parseWikiCommand("help"), { action: "help" });
  assert.deepEqual(parseWikiCommand("-h"), { action: "help" });
  assert.deepEqual(parseWikiCommand("--help"), { action: "help" });
});

test("parses workflow modes and focus", () => {
  assert.deepEqual(parseWikiCommand("--plan authentication model"), {
    action: "run",
    mode: "plan",
    focus: "authentication model",
  });
  assert.deepEqual(parseWikiCommand("--retry write \"API guide\""), {
    action: "run",
    mode: "retry-write",
    focus: "API guide",
  });
  assert.deepEqual(parseWikiCommand("run --plan auth"), {
    action: "run",
    mode: "plan",
    focus: "auth",
  });
});

test("parses initialization, sources, and JSON-only status", () => {
  assert.deepEqual(parseWikiCommand("init --name docs --lang zh --force"), {
    action: "init",
    name: "docs",
    wikiLanguage: "zh",
    force: true,
  });
  assert.deepEqual(parseWikiCommand("source add path ../service --id service"), {
    action: "source-add-link",
    path: "../service",
    id: "service",
  });
  assert.deepEqual(parseWikiCommand("source remove --id service"), { action: "source-remove", sourceId: "service" });
  assert.deepEqual(parseWikiCommand("status --json"), { action: "status" });
  assert.throws(() => parseWikiCommand("status"), /only supports --json/);
  assert.deepEqual(parseWikiCommand("pause pi-1"), { action: "pause", workflowRunId: "pi-1" });
});

test("removes duplicate observation commands", () => {
  for (const command of ["agents", "inspect", "fleet", "focus", "logs"]) {
    assert.throws(() => parseWikiCommand(command), WikiCommandError);
    assert.throws(() => parseWikiCommand(`${command} survey:1:2`), /was removed/);
  }
});

test("multi-word free text still runs; malformed source operations error", () => {
  assert.deepEqual(parseWikiCommand("repository architecture"), {
    action: "run",
    mode: "auto",
    focus: "repository architecture",
  });
  assert.throws(() => parseWikiCommand("foobar"), /Unknown subcommand/);
  assert.throws(() => parseWikiCommand("source add clone"), WikiCommandError);
  assert.throws(() => parseWikiCommand("init --lang ja"), WikiCommandError);
});

test("help and completions describe the single Navigator", () => {
  const help = formatWikiHelp();
  assert.match(help, /\/wiki\s+# open the live Navigator/);
  assert.match(help, /status --json/);
  assert.match(help, /phase, then an agent/i);
  assert.ok(!/\/wiki agents|\/wiki inspect|\/wiki focus|\/wiki logs/.test(help));

  const all = getWikiArgumentCompletions("");
  assert.ok(all.some((item) => item.value === "status --json"));
  assert.ok(!all.some((item) => /^(agents|inspect|fleet|focus|logs)/.test(item.value)));
  assert.deepEqual(getWikiArgumentCompletions("sta").map((item) => item.value), ["status --json"]);
});
