import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolCall } from "@okf-wiki/contract";
import { agentToolCallToViewModel } from "./tool-call.ts";
import {
  aggregateFileChanges,
  countUnifiedDiffStats,
  extractFileChange,
  extractToolChip,
  extractToolDetailLines,
} from "./tool-fields.ts";
import { inferToolKind, toolProductTitle } from "./tool-labels.ts";

test("toolProductTitle maps wiki_produce and falls back to spaced names", () => {
  assert.equal(toolProductTitle("wiki_produce"), "Generate wiki");
  assert.equal(toolProductTitle("wiki_produce", { wikiProduce: "生成 Wiki" }), "生成 Wiki");
  assert.equal(toolProductTitle("read_file"), "read file");
});

test("inferToolKind maps common tool names", () => {
  assert.equal(inferToolKind("grep"), "search");
  assert.equal(inferToolKind("glob"), "search");
  assert.equal(inferToolKind("ls"), "read");
  assert.equal(inferToolKind("edit"), "write");
  assert.equal(inferToolKind("bash"), "generic");
  assert.equal(inferToolKind("wiki_produce"), "wiki_produce");
});

test("extractToolChip prefers path over pattern", () => {
  const chip = extractToolChip({ path: "src/foo.ts", pattern: "bar" });
  assert.deepEqual(chip, { text: "src/foo.ts", mono: true });
});

test("extractToolChip falls back to pattern then summary", () => {
  assert.deepEqual(extractToolChip({ pattern: "ToolItemVM" }), {
    text: "ToolItemVM",
    mono: true,
  });
  assert.deepEqual(extractToolChip(undefined, { summary: "Run started" }), {
    text: "Run started",
    mono: false,
  });
});

test("extractToolDetailLines surfaces error first and skips chip duplicates", () => {
  const lines = extractToolDetailLines(
    { path: "a.ts", goal: "docs" },
    { summary: "failed" },
    {
      status: "error",
      errorText: "permission denied",
      summary: "failed",
      chipText: "a.ts",
    },
  );
  assert.ok(lines);
  assert.equal(lines![0]?.tone, "error");
  assert.equal(lines![0]?.text, "permission denied");
  assert.ok(lines!.some((line) => line.text.includes("goal")));
  assert.ok(!lines!.some((line) => line.text === "a.ts"));
});

test("agentToolCallToViewModel projects a running wiki_produce receipt", () => {
  const tool: AgentToolCall = {
    id: "t1",
    name: "wiki_produce",
    status: "running",
    args: { goal: "build docs" },
    details: { status: "accepted", runId: "run-abc", summary: "Run started" },
  };
  const vm = agentToolCallToViewModel(tool, { wikiProduce: "Generate wiki" });
  assert.equal(vm.id, "t1");
  assert.equal(vm.title, "Generate wiki");
  assert.equal(vm.technicalName, "wiki_produce");
  assert.equal(vm.status, "running");
  assert.equal(vm.kind, "wiki_produce");
  assert.equal(vm.openRunId, "run-abc");
  assert.equal(vm.summary, "Run started");
  assert.equal(vm.chip, "build docs");
  assert.equal(vm.defaultOpen, true);
  assert.match(vm.inputText ?? "", /build docs/);
  assert.ok(vm.detailLines?.some((line) => line.text.includes("goal") || line.text === "Run started"));
  assert.equal(vm.testId, "agent-tool-wiki_produce");
});

test("agentToolCallToViewModel keeps done tools collapsed unless errored", () => {
  const tool: AgentToolCall = {
    id: "t2",
    name: "read",
    status: "done",
    args: { path: "README.md" },
    output: "hello",
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.title, "read");
  assert.equal(vm.kind, "read");
  assert.equal(vm.status, "done");
  assert.equal(vm.defaultOpen, false);
  assert.equal(vm.chip, "README.md");
  assert.equal(vm.chipMono, true);
  assert.equal(vm.outputText, "hello");
  assert.equal(vm.openRunId, undefined);
});

test("agentToolCallToViewModel does not open done tools merely because args exist", () => {
  const tool: AgentToolCall = {
    id: "t2b",
    name: "grep",
    status: "done",
    args: { pattern: "foo", path: "src/" },
    output: "hits",
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.defaultOpen, false);
  assert.equal(vm.kind, "search");
  // path wins over pattern for chip when both present
  assert.equal(vm.chip, "src/");
  assert.ok(vm.inputText?.includes("pattern"));
});

test("agentToolCallToViewModel opens error tools and surfaces error text", () => {
  const tool: AgentToolCall = {
    id: "t3",
    name: "search",
    status: "error",
    output: "permission denied",
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.status, "error");
  assert.equal(vm.defaultOpen, true);
  assert.equal(vm.errorText, "permission denied");
  assert.equal(vm.kind, "search");
  assert.ok(vm.detailLines?.some((line) => line.tone === "error"));
});

test("agentToolCallToViewModel keeps summary separate from errorText", () => {
  const tool: AgentToolCall = {
    id: "t3b",
    name: "search",
    status: "error",
    output: "permission denied",
    details: { summary: "permission denied" },
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.errorText, "permission denied");
  assert.equal(vm.summary, "permission denied");
  assert.equal(vm.chip, "permission denied");
});

test("agentToolCallToViewModel does not promote summary to errorText when output missing", () => {
  const tool: AgentToolCall = {
    id: "t3c",
    name: "search",
    status: "error",
    details: { summary: "failed quietly" },
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.errorText, undefined);
  assert.equal(vm.summary, "failed quietly");
  assert.equal(vm.chip, "failed quietly");
});

test("agentToolCallToViewModel applies localized status labels", () => {
  const tool: AgentToolCall = {
    id: "t3d",
    name: "read",
    status: "running",
  };
  const vm = agentToolCallToViewModel(tool, {
    status: { running: "Running", done: "completed" },
  });
  assert.equal(vm.statusLabel, "Running");
});

test("agentToolCallToViewModel extracts wiki_repair runId from args", () => {
  const tool: AgentToolCall = {
    id: "t4",
    name: "wiki_repair",
    status: "done",
    args: { runId: "run-fix", nodeKey: "write.root" },
    output: "ok",
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.openRunId, "run-fix");
  assert.equal(vm.defaultOpen, false);
  assert.ok(vm.detailLines?.some((line) => line.text.includes("run-fix")));
});

test("agentToolCallToViewModel uses pattern as chip when no path", () => {
  const tool: AgentToolCall = {
    id: "t5",
    name: "grep",
    status: "done",
    args: { pattern: "ToolItemVM", query: "ignored-when-pattern" },
    output: "ok",
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.chip, "ToolItemVM");
  assert.equal(vm.defaultOpen, false);
});

test("countUnifiedDiffStats ignores headers", () => {
  const stats = countUnifiedDiffStats(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " context",
      "-old",
      "+new",
      "+more",
    ].join("\n"),
  );
  assert.equal(stats.add, 2);
  assert.equal(stats.del, 1);
});

test("extractFileChange reads unified diff from write output", () => {
  const change = extractFileChange(
    { path: "src/ChurnSchedule.tsx" },
    ["--- a/src/ChurnSchedule.tsx", "+++ b/src/ChurnSchedule.tsx", "@@ -1 +1,2 @@", "+const x = 1", "+const y = 2"].join(
      "\n",
    ),
    "write",
  );
  assert.deepEqual(change, { file: "ChurnSchedule.tsx", add: 2, del: 0 });
});

test("extractFileChange counts write content lines", () => {
  const change = extractFileChange(
    { path: "menu.ts", content: "a\nb\nc\n" },
    undefined,
    "write",
  );
  assert.deepEqual(change, { file: "menu.ts", add: 3, del: 0 });
});

test("extractFileChange ignores read tools", () => {
  assert.equal(
    extractFileChange({ path: "README.md", content: "hello" }, undefined, "read"),
    undefined,
  );
});

test("agentToolCallToViewModel attaches fileChange for write tools", () => {
  const tool: AgentToolCall = {
    id: "t6",
    name: "write",
    status: "done",
    args: { path: "flavors.css", content: "a\nb\n" },
    output: "ok",
  };
  const vm = agentToolCallToViewModel(tool);
  assert.deepEqual(vm.fileChange, { file: "flavors.css", add: 2, del: 0 });
});

test("aggregateFileChanges sums per file", () => {
  const merged = aggregateFileChanges([
    { fileChange: { file: "a.ts", add: 1, del: 0 } },
    { fileChange: { file: "a.ts", add: 2, del: 3 } },
    { fileChange: { file: "b.ts", add: 4, del: 1 } },
  ]);
  assert.deepEqual(merged, [
    { file: "a.ts", add: 3, del: 3 },
    { file: "b.ts", add: 4, del: 1 },
  ]);
});
