import assert from "node:assert/strict";
import test from "node:test";
import {
  boundToolExecutionResult,
  boundToolResultText,
  TOOL_RESULT_MAX_LINES,
} from "../dist/tool-budget.js";

test("boundToolResultText preserves short text without truncation", () => {
  const text = "line one\nline two\nline three";
  const result = boundToolResultText(text, { maxLines: 10, maxBytes: 1024 });
  assert.equal(result.truncated, false);
  assert.equal(result.text, text);
});

test("boundToolResultText truncates long multi-line text and keeps head/tail", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
  const result = boundToolResultText(lines.join("\n"), { maxLines: 5, maxBytes: 64 * 1024, label: "grep" });
  assert.equal(result.truncated, true);
  assert.match(result.text, /lines omitted/);
  assert.match(result.text, /^line-1\n/);
  assert.match(result.text, /line-20$/);
  assert.ok(result.text.split("\n").length <= 6);
});

test("boundToolResultText truncates oversized byte payloads", () => {
  const text = "x".repeat(200);
  const result = boundToolResultText(text, { maxLines: 1000, maxBytes: 80 });
  assert.equal(result.truncated, true);
  assert.match(result.text, /truncated to 80 bytes/);
  assert.ok(Buffer.byteLength(result.text, "utf8") < Buffer.byteLength(text, "utf8"));
});

test("boundToolExecutionResult leaves short tool results unchanged", () => {
  const original = {
    content: [{ type: "text", text: "ok" }],
    details: { path: "a.ts" },
  };
  const next = boundToolExecutionResult(original, "read");
  assert.equal(next, original);
});

test("boundToolExecutionResult bounds grep-style match output", () => {
  const lines = Array.from({ length: TOOL_RESULT_MAX_LINES }, (_, i) => `match-${i}`);
  // grep uses a lower match-line cap than generic tools.
  const original = {
    content: [{ type: "text", text: lines.join("\n") }],
  };
  const next = boundToolExecutionResult(original, "grep");
  assert.notEqual(next, original);
  assert.equal(next.content[0].type, "text");
  assert.match(next.content[0].text, /omitted|truncated/);
});
