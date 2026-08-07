import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWikiHelp,
  getWikiArgumentCompletions,
  parseWikiCommand,
  WikiCommandError,
} from "../dist/command.js";

test("empty and help verbs show help (not auto-run)", () => {
  assert.deepEqual(parseWikiCommand(""), { action: "help" });
  assert.deepEqual(parseWikiCommand("   "), { action: "help" });
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
  assert.deepEqual(parseWikiCommand("run authentication model"), {
    action: "run",
    mode: "auto",
    focus: "authentication model",
  });
  assert.deepEqual(parseWikiCommand("run --plan auth"), {
    action: "run",
    mode: "plan",
    focus: "auth",
  });
});

test("multi-word free text still runs; single unknown token errors", () => {
  assert.deepEqual(parseWikiCommand("repository architecture"), {
    action: "run",
    mode: "auto",
    focus: "repository architecture",
  });
  assert.throws(() => parseWikiCommand("foobar"), WikiCommandError);
  assert.throws(() => parseWikiCommand("foobar"), /Unknown subcommand/);
});

test("parses explicit initialization and source management", () => {
  assert.deepEqual(parseWikiCommand("init --name docs --lang zh --force"), {
    action: "init",
    name: "docs",
    wikiLanguage: "zh",
    force: true,
  });
  assert.deepEqual(parseWikiCommand("source add clone https://example.test/repo.git --id api"), {
    action: "source-add-clone",
    url: "https://example.test/repo.git",
    id: "api",
  });
  assert.deepEqual(parseWikiCommand("source add path ../service --id service"), {
    action: "source-add-link",
    path: "../service",
    id: "service",
  });
  assert.deepEqual(parseWikiCommand("source remove --id service"), { action: "source-remove", sourceId: "service" });
  assert.deepEqual(parseWikiCommand("status"), { action: "status", json: undefined });
  assert.deepEqual(parseWikiCommand("status --json"), { action: "status", json: true });
  assert.deepEqual(parseWikiCommand("pause pi-1"), { action: "pause", workflowRunId: "pi-1" });
});

test("parses agents, inspect/fleet, focus, and logs", () => {
  assert.deepEqual(parseWikiCommand("agents"), { action: "agents", agentId: undefined });
  assert.deepEqual(parseWikiCommand("agents survey:1:2"), { action: "agents", agentId: "survey:1:2" });
  assert.deepEqual(parseWikiCommand("inspect"), { action: "inspect" });
  assert.deepEqual(parseWikiCommand("fleet"), { action: "inspect" });
  assert.deepEqual(parseWikiCommand("focus survey:1:2"), { action: "focus", agentId: "survey:1:2" });
  assert.throws(() => parseWikiCommand("focus"), WikiCommandError);
  assert.throws(() => parseWikiCommand("focus"), /focus <agentId>/);

  assert.deepEqual(parseWikiCommand("logs"), { action: "logs", agentId: undefined, tail: undefined });
  assert.deepEqual(parseWikiCommand("logs survey:1:2"), {
    action: "logs",
    agentId: "survey:1:2",
    tail: undefined,
  });
  assert.deepEqual(parseWikiCommand("logs --tail 50"), {
    action: "logs",
    agentId: undefined,
    tail: 50,
  });
  assert.deepEqual(parseWikiCommand("logs survey:1:2 --tail 20"), {
    action: "logs",
    agentId: "survey:1:2",
    tail: 20,
  });
  assert.deepEqual(parseWikiCommand("logs --tail 10 survey:1:3"), {
    action: "logs",
    agentId: "survey:1:3",
    tail: 10,
  });
  assert.throws(() => parseWikiCommand("logs --tail"), WikiCommandError);
  assert.throws(() => parseWikiCommand("logs --tail no"), WikiCommandError);
});

test("rejects malformed source operations", () => {
  assert.throws(() => parseWikiCommand("source add clone"), WikiCommandError);
  assert.throws(() => parseWikiCommand("source add link --path"), WikiCommandError);
  assert.throws(() => parseWikiCommand("init --lang ja"), WikiCommandError);
});

test("formatWikiHelp covers usage, trust, and disambiguation", () => {
  const help = formatWikiHelp();
  assert.match(help, /\/wiki help/);
  assert.match(help, /pi-llm-wiki/i);
  assert.match(help, /trusted/i);
  assert.match(help, /wiki-status/);
  assert.match(help, /does not auto-start/i);
  assert.match(help, /\/wiki agents/);
  assert.match(help, /\/wiki inspect/);
  assert.match(help, /\/wiki focus/);
  assert.match(help, /\/wiki logs/);
});

test("getWikiArgumentCompletions filters by prefix", () => {
  const all = getWikiArgumentCompletions("");
  assert.ok(all.length >= 5);
  assert.ok(all.some((item) => item.value === "status"));
  assert.ok(all.some((item) => item.value === "agents"));
  assert.ok(all.some((item) => item.value === "inspect"));

  const status = getWikiArgumentCompletions("sta");
  assert.deepEqual(
    status.map((item) => item.value),
    ["status", "status --json"],
  );

  const sources = getWikiArgumentCompletions("source");
  assert.ok(sources.every((item) => item.value.startsWith("source")));

  const agents = getWikiArgumentCompletions("ag");
  assert.ok(agents.some((item) => item.value === "agents"));
});
