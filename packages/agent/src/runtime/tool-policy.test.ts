import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_OPERATOR_TOOLS, OperatorToolNameSchema } from "@okf-wiki/contract/workspace";
import {
  assertSafeWikiToolList,
  isReadOnlyToolList,
  OPERATOR_SELECTABLE_TOOLS,
  resolveOperatorToolNames,
  roleMayWrite,
  toolNamesForRole,
} from "./tool-policy.js";

describe("tool-policy", () => {
  it("plan / research / reviewer are read-only Pi tools", () => {
    for (const role of ["plan", "root_research", "domain", "leaf", "reviewer"] as const) {
      const tools = toolNamesForRole(role);
      assert.deepEqual([...tools], ["read", "grep", "find", "ls"]);
      assert.equal(roleMayWrite(role), false);
      assert.equal(isReadOnlyToolList(tools), true);
      assertSafeWikiToolList(tools);
    }
  });

  it("operator chat is read-only Pi tools (never write/edit/bash)", () => {
    const tools = toolNamesForRole("operator_chat");
    assert.deepEqual([...tools], ["read", "grep", "find", "ls"]);
    assert.equal(roleMayWrite("operator_chat"), false);
    assert.equal(isReadOnlyToolList(tools), true);
  });

  it("root_write adds write and edit only", () => {
    const tools = toolNamesForRole("root_write");
    assert.deepEqual([...tools], ["read", "grep", "find", "ls", "write", "edit"]);
    assert.equal(roleMayWrite("root_write"), true);
    assertSafeWikiToolList(tools);
  });

  it("rejects bash and unknown tools", () => {
    assert.throws(() => assertSafeWikiToolList(["bash"]), /forbidden/);
    assert.throws(() => assertSafeWikiToolList(["list_source"]), /unknown/);
  });
});

describe("resolveOperatorToolNames", () => {
  it("selectable set matches contract OperatorToolNameSchema", () => {
    assert.deepEqual([...OPERATOR_SELECTABLE_TOOLS], [...OperatorToolNameSchema.options]);
  });

  it("defaults to contract DEFAULT_OPERATOR_TOOLS when no selection is stored", () => {
    assert.deepEqual([...resolveOperatorToolNames(undefined)], [...DEFAULT_OPERATOR_TOOLS]);
    assert.deepEqual([...DEFAULT_OPERATOR_TOOLS], ["read", "grep", "find", "ls"]);
  });

  it("accepts partial selections, dedupes, and allows the bash opt-in", () => {
    assert.deepEqual([...resolveOperatorToolNames(["read", "read", "bash"])], ["read", "bash"]);
    assert.deepEqual([...resolveOperatorToolNames([])], []);
  });

  it("rejects unknown or workflow-only tool names", () => {
    assert.throws(() => resolveOperatorToolNames(["write"]), /unknown operator tool/);
    assert.throws(() => resolveOperatorToolNames(["docker"]), /unknown operator tool/);
  });
});
