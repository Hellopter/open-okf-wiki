import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateActionPresentationForWidth } from "./gate-action-presentation.ts";

describe("gateActionPresentationForWidth", () => {
  it("keeps exactly one GateAction host across the documented breakpoints", () => {
    assert.equal(gateActionPresentationForWidth(1280), "dock");
    assert.equal(gateActionPresentationForWidth(1279), "sheet");
    assert.equal(gateActionPresentationForWidth(768), "sheet");
    assert.equal(gateActionPresentationForWidth(767), "drawer");
  });
});
