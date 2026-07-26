import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { piSessionsDir } from "../session/operator-session.js";
import { createWikiSession, resolveWikiSessionTools } from "./create-wiki-session.js";
import { assertSafeWikiToolList, toolNamesForRole } from "./tool-policy.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await rm(t, { recursive: true, force: true });
  }
});

describe("create-wiki-session tool list safety", () => {
  it("resolveWikiSessionTools never includes bash", () => {
    for (const role of [
      "plan",
      "root_research",
      "root_write",
      "domain",
      "leaf",
      "reviewer",
    ] as const) {
      const tools = resolveWikiSessionTools(role);
      assert.deepEqual([...tools], [...toolNamesForRole(role)]);
      assertSafeWikiToolList(tools);
      assert.ok(!tools.includes("bash" as never));
    }
  });

  it("operator chat resolves read-only Pi tools", () => {
    assert.deepEqual([...resolveWikiSessionTools("operator_chat")], ["read", "grep", "find", "ls"]);
  });

  it("root_write allowlist is read+write Pi tools only", () => {
    const tools = resolveWikiSessionTools("root_write");
    assert.deepEqual([...tools], ["read", "grep", "find", "ls", "write", "edit"]);
  });

  it("createWikiSession offline returns safe tools and dispose works", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-sess-"));
    temps.push(tmp);
    const runWorkDir = path.join(tmp, "run");

    const handle = await createWikiSession({
      role: "root_research",
      runWorkDir,
      systemPrompt: "test offline session",
    });

    try {
      assert.equal(handle.role, "root_research");
      assert.deepEqual([...handle.tools], ["read", "grep", "find", "ls"]);
      assertSafeWikiToolList(handle.tools);
      assert.ok(!handle.tools.includes("bash" as never));
      assert.ok(handle.session);
      assert.equal(handle.runWorkDir, path.resolve(runWorkDir));
      assert.equal(handle.scopedTools, true);
    } finally {
      handle.dispose();
    }
  });

  it("createWikiSession root_write tools include write/edit not bash", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-sess-w-"));
    temps.push(tmp);

    const handle = await createWikiSession({
      role: "root_write",
      runWorkDir: path.join(tmp, "run"),
    });

    try {
      assert.deepEqual([...handle.tools], ["read", "grep", "find", "ls", "write", "edit"]);
      assert.ok(!handle.tools.includes("bash" as never));
    } finally {
      handle.dispose();
    }
  });

  it("operator toolSelection supports partial sets and the bash opt-in", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-sess-sel-"));
    temps.push(tmp);

    const handle = await createWikiSession({
      role: "operator_chat",
      runWorkDir: path.join(tmp, "run"),
      toolSelection: ["read", "grep", "bash"],
    });
    try {
      assert.deepEqual([...handle.tools], ["read", "grep", "bash"]);
      // Selected fs tools keep Operations scoping; bash is the stock Pi tool.
      const active = handle.session.getActiveToolNames();
      assert.ok(active.includes("read"));
      assert.ok(active.includes("bash"));
      assert.ok(!active.includes("find"));
      assert.ok(!active.includes("write"));
    } finally {
      handle.dispose();
    }
  });

  it("toolSelection is rejected for Semantic Workflow roles", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-sess-selrole-"));
    temps.push(tmp);
    await assert.rejects(
      createWikiSession({
        role: "domain",
        runWorkDir: path.join(tmp, "run"),
        toolSelection: ["read"],
      }),
      /only valid for operator_chat/,
    );
  });

  it("unknown operator tool names are rejected", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-sess-selbad-"));
    temps.push(tmp);
    await assert.rejects(
      createWikiSession({
        role: "operator_chat",
        runWorkDir: path.join(tmp, "run"),
        toolSelection: ["write"],
      }),
      /unknown operator tool/,
    );
  });
});

describe("session-paths", () => {
  it("keeps Operator Session JSONL under .okf-wiki", () => {
    const root = "/workspace/repo";
    assert.equal(piSessionsDir(root), path.join(root, ".okf-wiki", "pi-sessions"));
  });
});
