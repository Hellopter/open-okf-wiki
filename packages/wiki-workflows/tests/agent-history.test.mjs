import assert from "node:assert/strict";
import test from "node:test";
import { compactWikiHistory } from "../dist/agent-history.js";

test("compactWikiHistory returns [] for empty or non-array messages", () => {
  assert.deepEqual(compactWikiHistory([]), []);
  assert.deepEqual(compactWikiHistory(undefined), []);
  assert.deepEqual(compactWikiHistory(null), []);
  assert.deepEqual(compactWikiHistory("not-an-array"), []);
});

test("compactWikiHistory captures user, assistant, tool call, tool result, and error", () => {
  const history = compactWikiHistory([
    { role: "user", content: "inspect repo", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", name: "read", arguments: { file: "README.md" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "README content" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [],
      errorMessage: "model failed",
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "exit 1" }],
      isError: true,
      timestamp: 5,
    },
  ]);

  assert.deepEqual(
    history.map((entry) => [entry.role, entry.kind, entry.toolName, entry.text, entry.isError]),
    [
      ["user", "text", undefined, "inspect repo", undefined],
      ["assistant", "text", undefined, "I will inspect it.", undefined],
      ["assistant", "toolCall", "read", '{"file":"README.md"}', undefined],
      ["tool", "toolResult", "read", "README content", false],
      ["assistant", "error", undefined, "model failed", true],
      ["tool", "error", "bash", "exit 1", true],
    ],
  );
});

test("compactWikiHistory maxEntries keeps the last N entries", () => {
  const history = compactWikiHistory(
    [
      { role: "user", content: "one" },
      { role: "user", content: "two" },
      { role: "user", content: "three" },
    ],
    { maxEntries: 2 },
  );

  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((entry) => entry.text),
    ["two", "three"],
  );
});

test("compactWikiHistory truncates long text with the truncated marker", () => {
  const history = compactWikiHistory([{ role: "user", content: "Z".repeat(100) }], { maxTextChars: 30 });

  assert.equal(history.length, 1);
  assert.match(history[0].text, /truncated/);
  assert.ok(history[0].text.endsWith("... [truncated]"));
  assert.ok(history[0].text.length <= 30);
});

test("compactWikiHistory total budget stops adding older entries", () => {
  const history = compactWikiHistory(
    [
      { role: "user", content: "AAAA" },
      { role: "user", content: "BBBB" },
      { role: "user", content: "CCCC" },
    ],
    { maxEntries: 10, maxTextChars: 100, maxTotalChars: 8 },
  );

  assert.deepEqual(
    history.map((entry) => entry.text),
    ["BBBB", "CCCC"],
  );
});

test("compactWikiHistory write toolCall preserves path and source content", () => {
  const history = compactWikiHistory(
    [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "write",
            arguments: { path: "src/example.rs", content: `fn main() {\n${"x".repeat(100)}\n}` },
          },
        ],
      },
    ],
    { maxTextChars: 50 },
  );

  assert.equal(history[0]?.path, "src/example.rs");
  assert.equal(history[0]?.kind, "toolCall");
  assert.equal(history[0]?.toolName, "write");
  assert.match(history[0]?.text ?? "", /^fn main/);
  assert.match(history[0]?.text ?? "", /truncated/);
  assert.doesNotMatch(history[0]?.text ?? "", /"content":/);
});

test("compactWikiHistory folds edit result diffs into text and keeps the edit path", () => {
  const history = compactWikiHistory([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "edit",
          arguments: { path: "src/example.ts", edits: [{ oldText: "old", newText: "new" }] },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
      details: { diff: "-1 old\n+1 new" },
      isError: false,
    },
  ]);

  assert.equal(history[0]?.path, "src/example.ts");
  assert.equal(history[1]?.diff, undefined);
  assert.match(history[1]?.text ?? "", /Successfully replaced 1 block\(s\)/);
  assert.match(history[1]?.text ?? "", /-1 old/);
  assert.match(history[1]?.text ?? "", /\+1 new/);
});
