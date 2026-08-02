import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolCall } from "@okf-wiki/contract";
import { agentToolCallToViewModel } from "./tool-call.ts";
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
  assert.equal(vm.headline, "Run started");
  assert.equal(vm.defaultOpen, true);
  assert.match(vm.inputText ?? "", /build docs/);
  assert.ok(vm.primaryFields?.some((f) => f.label === "goal"));
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
  assert.equal(vm.headline, "README.md");
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
  // path wins over pattern for headline when both present
  assert.equal(vm.headline, "src/");
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
  assert.equal(vm.headline, "permission denied");
  // Item UI dedupes identical summary/error; adapter must not drop summary into errorText alone.
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
  assert.equal(vm.headline, "failed quietly");
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
  assert.ok(vm.primaryFields?.some((f) => f.label === "runId" && f.value === "run-fix"));
});

test("agentToolCallToViewModel uses pattern as headline when no path", () => {
  const tool: AgentToolCall = {
    id: "t5",
    name: "grep",
    status: "done",
    args: { pattern: "ToolItemVM", query: "ignored-when-pattern" },
    output: "ok",
  };
  const vm = agentToolCallToViewModel(tool);
  assert.equal(vm.headline, "ToolItemVM");
  assert.equal(vm.defaultOpen, false);
});
