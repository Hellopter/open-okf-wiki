import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expandOperatorCommand,
  listOperatorCommands,
  parseCommandArgs,
  substituteArgs,
} from "./operator-commands.js";

describe("parseCommandArgs", () => {
  it("splits on whitespace and honors quotes", () => {
    assert.deepEqual(parseCommandArgs("a b c"), ["a", "b", "c"]);
    assert.deepEqual(parseCommandArgs('one "two three" four'), ["one", "two three", "four"]);
    assert.deepEqual(parseCommandArgs("  'a b'  "), ["a b"]);
    assert.deepEqual(parseCommandArgs(""), []);
    assert.deepEqual(parseCommandArgs('""'), [""]);
  });
});

describe("substituteArgs", () => {
  it("substitutes positional, all-args, and defaults", () => {
    assert.equal(substituteArgs("x $1 y $2", ["a", "b"]), "x a y b");
    assert.equal(substituteArgs("all: $@", ["a", "b"]), "all: a b");
    assert.equal(substituteArgs("all: $ARGUMENTS", ["a"]), "all: a");
    assert.equal(substituteArgs("v ${1:-def}", []), "v def");
    assert.equal(substituteArgs("v ${1:-def}", ["x"]), "v x");
    assert.equal(substituteArgs("n ${@:-none}", []), "n none");
    assert.equal(substituteArgs("n ${@:-none}", ["a", "b"]), "n a b");
    assert.equal(substituteArgs("missing $3", ["a"]), "missing ");
  });
});

describe("expandOperatorCommand", () => {
  it("expands /wiki with notes into a wiki_produce prompt", () => {
    const result = expandOperatorCommand("/wiki focus on architecture");
    assert.equal(result.kind, "expanded");
    if (result.kind !== "expanded") return;
    assert.equal(result.command, "wiki");
    assert.match(result.prompt, /wiki_produce/);
    assert.match(result.prompt, /focus on architecture/);
  });

  it("expands /wiki without notes using the default placeholder", () => {
    const result = expandOperatorCommand("/wiki");
    assert.equal(result.kind, "expanded");
    if (result.kind !== "expanded") return;
    assert.match(result.prompt, /\(none\)/);
  });

  it("expands /repair and /status", () => {
    const repair = expandOperatorCommand("/repair overview cites wrong lines");
    assert.equal(repair.kind, "expanded");
    if (repair.kind === "expanded") {
      assert.match(repair.prompt, /wiki_repair/);
      assert.match(repair.prompt, /overview cites wrong lines/);
    }
    const status = expandOperatorCommand("/status");
    assert.equal(status.kind, "expanded");
    if (status.kind === "expanded") assert.match(status.prompt, /session_status/);
  });

  it("reports unknown slash commands", () => {
    const result = expandOperatorCommand("/deploy prod");
    assert.deepEqual(result, { kind: "unknown", command: "deploy" });
  });

  it("treats path-like input and plain text as not_command", () => {
    assert.deepEqual(expandOperatorCommand("/home/user/repo 是什么"), { kind: "not_command" });
    assert.deepEqual(expandOperatorCommand("generate the wiki"), { kind: "not_command" });
    assert.deepEqual(expandOperatorCommand("/"), { kind: "not_command" });
  });

  it("is case-insensitive on the command name", () => {
    const result = expandOperatorCommand("/WIKI");
    assert.equal(result.kind, "expanded");
  });
});

describe("listOperatorCommands", () => {
  it("exposes name/description for autocomplete", () => {
    const names = listOperatorCommands().map((c) => c.name);
    assert.deepEqual(names, ["wiki", "repair", "status"]);
    for (const c of listOperatorCommands()) {
      assert.ok(c.description.length > 0);
    }
  });
});
