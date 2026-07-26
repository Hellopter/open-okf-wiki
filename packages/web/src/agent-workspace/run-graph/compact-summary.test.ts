import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactSummary } from "./compact-summary.ts";

describe("compactSummary", () => {
  it("returns empty for blank", () => {
    assert.equal(compactSummary(""), "");
    assert.equal(compactSummary(null), "");
    assert.equal(compactSummary(undefined), "");
  });

  it("takes the first meaningful line and strips markdown", () => {
    const raw = `# Domain receipt\n\n**nodeId:** x\n\n## Key findings\n- AI-native Chrome extension`;
    assert.equal(compactSummary(raw), "Domain receipt");
  });

  it("truncates long single lines", () => {
    const long = "a".repeat(100);
    const out = compactSummary(long, 20);
    assert.ok(out.endsWith("…"));
    assert.ok(out.length <= 20);
  });

  it("skips table rows and horizontal rules", () => {
    const raw = `| Path | Package |\n|------|------|\n| a | b |\n\n---\n\nReal finding about the monorepo.`;
    assert.equal(compactSummary(raw), "Real finding about the monorepo.");
  });
});
