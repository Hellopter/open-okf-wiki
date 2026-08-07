import assert from "node:assert/strict";
import test from "node:test";
import { parseWikiCommand, WikiCommandError } from "../dist/command.js";

test("parses workflow modes and focus", () => {
  assert.deepEqual(parseWikiCommand(""), { action: "run", mode: "auto", focus: undefined });
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
});

test("rejects malformed source operations", () => {
  assert.throws(() => parseWikiCommand("source add clone"), WikiCommandError);
  assert.throws(() => parseWikiCommand("source add link --path"), WikiCommandError);
  assert.throws(() => parseWikiCommand("init --lang ja"), WikiCommandError);
});
