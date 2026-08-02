import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptTraceEvent } from "@okf-wiki/contract";
import { attemptToolToViewModel } from "./attempt-trace.ts";

const at = "2026-08-02T12:00:00.000Z";

function call(
  partial: Partial<Extract<AttemptTraceEvent, { kind: "tool_call" }>> &
    Pick<Extract<AttemptTraceEvent, { kind: "tool_call" }>, "ordinal" | "name">,
): Extract<AttemptTraceEvent, { kind: "tool_call" }> {
  return {
    trace: 1,
    at,
    kind: "tool_call",
    ...partial,
  };
}

function result(
  partial: Partial<Extract<AttemptTraceEvent, { kind: "tool_result" }>> &
    Pick<Extract<AttemptTraceEvent, { kind: "tool_result" }>, "ordinal" | "name" | "status">,
): Extract<AttemptTraceEvent, { kind: "tool_result" }> {
  return {
    trace: 1,
    at,
    kind: "tool_result",
    ...partial,
  };
}

test("attemptToolToViewModel pairs call + done result", () => {
  const vm = attemptToolToViewModel(
    call({
      ordinal: 1,
      name: "wiki_produce",
      toolCallId: "tc-1",
      args: '{"goal":"docs"}',
    }),
    result({
      ordinal: 2,
      name: "wiki_produce",
      toolCallId: "tc-1",
      status: "done",
      output: "accepted",
    }),
    { wikiProduce: "Generate wiki" },
  );
  assert.equal(vm.id, "tc-1");
  assert.equal(vm.title, "Generate wiki");
  assert.equal(vm.status, "done");
  assert.match(vm.inputText ?? "", /docs/);
  assert.equal(vm.outputText, "accepted");
  assert.equal(vm.defaultOpen, false);
  assert.equal(vm.kind, "wiki_produce");
  assert.equal(vm.headline, "docs");
  assert.ok(vm.primaryFields?.some((f) => f.label === "goal"));
});

test("attemptToolToViewModel treats missing result as running", () => {
  const vm = attemptToolToViewModel(
    call({
      ordinal: 3,
      name: "read_file",
      toolCallId: "tc-2",
      args: '{"path":"README.md"}',
    }),
  );
  assert.equal(vm.status, "running");
  assert.equal(vm.defaultOpen, true);
  assert.equal(vm.title, "read file");
  assert.equal(vm.kind, "read");
  assert.equal(vm.headline, "README.md");
});

test("attemptToolToViewModel maps error results and opens by default", () => {
  const vm = attemptToolToViewModel(
    call({ ordinal: 4, name: "write", toolCallId: "tc-3" }),
    result({
      ordinal: 5,
      name: "write",
      toolCallId: "tc-3",
      status: "error",
      output: "disk full",
    }),
  );
  assert.equal(vm.status, "error");
  assert.equal(vm.errorText, "disk full");
  assert.equal(vm.defaultOpen, true);
  assert.equal(vm.kind, "write");
});

test("attemptToolToViewModel supports orphan tool_result", () => {
  const vm = attemptToolToViewModel(
    undefined,
    result({
      ordinal: 9,
      name: "search",
      toolCallId: "tc-orphan",
      status: "done",
      output: "hits",
    }),
  );
  assert.equal(vm.id, "tc-orphan");
  assert.equal(vm.status, "done");
  assert.equal(vm.outputText, "hits");
  assert.equal(vm.title, "search");
  assert.equal(vm.defaultOpen, false);
});

test("attemptToolToViewModel parses string JSON args for headline", () => {
  const vm = attemptToolToViewModel(
    call({
      ordinal: 10,
      name: "grep",
      toolCallId: "tc-grep",
      args: '{"pattern":"defaultOpen","path":"src/adapters"}',
    }),
    result({
      ordinal: 11,
      name: "grep",
      toolCallId: "tc-grep",
      status: "done",
      output: "ok",
    }),
  );
  assert.equal(vm.kind, "search");
  assert.equal(vm.headline, "src/adapters");
  assert.equal(vm.defaultOpen, false);
});
