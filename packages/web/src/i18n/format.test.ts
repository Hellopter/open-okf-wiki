import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMessage } from "./format.ts";

describe("formatMessage", () => {
  it("replaces {name} placeholders with string and number values", () => {
    assert.equal(formatMessage("Hello, {name}!", { name: "Ada" }), "Hello, Ada!");
    assert.equal(formatMessage("{n} sources", { n: 3 }), "3 sources");
  });

  it("replaces multiple distinct placeholders", () => {
    assert.equal(
      formatMessage("Delete “{name}” ({id})?", { name: "Demo", id: "ws_1" }),
      "Delete “Demo” (ws_1)?",
    );
  });

  it("leaves unknown placeholders intact", () => {
    assert.equal(
      formatMessage("Hi {name}, see {missing}", { name: "Bob" }),
      "Hi Bob, see {missing}",
    );
  });

  it("returns the template unchanged when there are no placeholders", () => {
    assert.equal(formatMessage("Saved", {}), "Saved");
  });

  it("stringifies numeric vars", () => {
    assert.equal(formatMessage("models: {n}", { n: 0 }), "models: 0");
  });
});
