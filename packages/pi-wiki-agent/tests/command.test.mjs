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
  assert.deepEqual(parseWikiCommand("status"), { action: "status" });
  assert.deepEqual(parseWikiCommand("pause pi-1"), { action: "pause", workflowRunId: "pi-1" });
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
});

test("getWikiArgumentCompletions filters by prefix", () => {
  const all = getWikiArgumentCompletions("");
  assert.ok(all.length >= 5);
  assert.ok(all.some((item) => item.value === "status"));

  const status = getWikiArgumentCompletions("sta");
  assert.deepEqual(
    status.map((item) => item.value),
    ["status"],
  );

  const sources = getWikiArgumentCompletions("source");
  assert.ok(sources.every((item) => item.value.startsWith("source")));
});
