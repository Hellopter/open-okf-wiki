import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRunCancellable, isTerminalWikiRunState } from "./run-actions.ts";

describe("isRunCancellable", () => {
  it("keeps a newly accepted run cancellable before its first snapshot", () => {
    assert.equal(isRunCancellable(undefined, false), true);
  });

  it("accepts only active Run states", () => {
    assert.equal(isRunCancellable("queued", false), true);
    assert.equal(isRunCancellable("running", false), true);
    assert.equal(isRunCancellable("cancelling", false), true);
    assert.equal(isRunCancellable("waiting_for_operator", false), false);
    assert.equal(isRunCancellable("published", false), false);
  });

  it("does not offer a command while the selected Run has failed to load", () => {
    assert.equal(isRunCancellable(undefined, true), false);
  });
});

describe("isTerminalWikiRunState", () => {
  it("identifies terminal Run states for list refresh", () => {
    assert.equal(isTerminalWikiRunState("published"), true);
    assert.equal(isTerminalWikiRunState("cancelled"), true);
    assert.equal(isTerminalWikiRunState("running"), false);
  });
});
