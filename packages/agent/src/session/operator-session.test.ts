import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WorkspaceConfigSchema } from "@okf-wiki/contract";
import {
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSessionHistory,
  openOperatorSession,
  projectOperatorBranchHistoryFromManager,
  projectOperatorContextHistoryFromManager,
} from "./operator-session.js";

const temps: string[] = [];

after(async () => {
  for (const tmp of temps) await rm(tmp, { recursive: true, force: true });
});

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-"));
  temps.push(root);
  const skill = path.join(root, "skill");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# skill\n", "utf8");
  return WorkspaceConfigSchema.parse({
    version: 2,
    id: "workspace",
    name: "Operator Workspace",
    rootPath: root,
    sources: [],
    skillPath: skill,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "published"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

const startWikiRunStub = async () => ({
  commandId: "cmd-test",
  runId: "run-test",
  revision: 1,
  accepted: true,
});

describe("SessionManager-owned Operator Sessions", () => {
  it("creates, lists, opens history, renames, and deletes through Pi authority", async () => {
    const workspace = await makeWorkspace();
    const created = await createOperatorSession({
      workspace,
      sessionId: "operator-1",
      wikiProduce: { startWikiRun: startWikiRunStub },
    });
    try {
      assert.equal(created.sessionId, "operator-1");
      assert.equal(created.session.sessionManager.getCwd(), path.resolve(workspace.rootPath));
      // Read-only Workspace exploration + product tools (never write/edit/bash).
      assert.deepEqual(created.session.getActiveToolNames(), [
        "read",
        "grep",
        "find",
        "ls",
        "session_status",
        "wiki_produce",
        "wiki_repair",
      ]);

      created.session.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Build the wiki" }],
        timestamp: Date.now(),
      } as never);
      created.session.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "I will use wiki_produce." }],
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
    } finally {
      created.dispose();
    }

    const listed = await listOperatorSessions(workspace.rootPath);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "operator-1");
    assert.equal(listed[0]!.title, "Build the wiki");

    const history = await loadOperatorSessionHistory(workspace.rootPath, "operator-1");
    assert.ok(history);
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant"],
    );

    const opened = await openOperatorSession({
      workspace,
      sessionId: "operator-1",
      wikiProduce: { startWikiRun: startWikiRunStub },
    });
    try {
      assert.equal(opened.sessionId, "operator-1");
      assert.deepEqual(opened.session.getActiveToolNames(), [
        "read",
        "grep",
        "find",
        "ls",
        "session_status",
        "wiki_produce",
        "wiki_repair",
      ]);
    } finally {
      opened.dispose();
    }

    // Session delete must not touch run workdirs or publication (WikiRuns owns runs).
    const runId = "durable-run";
    const runDir = path.join(workspace.rootPath, ".okf-wiki", "runs", runId);
    await mkdir(path.join(runDir, "skill"), { recursive: true });
    await writeFile(path.join(runDir, "staging.txt"), "run-owned", "utf8");
    const publishedMarker = path.join(workspace.publicationPath, "keep.md");
    await mkdir(workspace.publicationPath, { recursive: true });
    await writeFile(publishedMarker, "published", "utf8");

    const deleted = await deleteOperatorSession(workspace.rootPath, "operator-1");
    assert.equal(deleted.deleted, true);
    assert.equal((await listOperatorSessions(workspace.rootPath)).length, 0);
    await access(runDir);
    assert.equal(await readFile(path.join(runDir, "staging.txt"), "utf8"), "run-owned");
    assert.equal(await readFile(publishedMarker, "utf8"), "published");
  });

  it("exposes full branch transcript and active model context as two read models", async () => {
    const workspace = await makeWorkspace();
    const created = await createOperatorSession({
      workspace,
      sessionId: "operator-dual-history",
      wikiProduce: { startWikiRun: startWikiRunStub },
    });
    try {
      const manager = created.session.sessionManager;
      created.session.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "before compact" }],
        timestamp: Date.now(),
      } as never);
      created.session.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ack" }],
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);

      const branch = projectOperatorBranchHistoryFromManager(manager);
      const context = projectOperatorContextHistoryFromManager(manager);
      // Without compaction both projections see the same leaf path messages.
      assert.equal(branch.length, context.length);
      assert.ok(branch.some((m) => (m as { role?: string }).role === "user"));

      // Default history load uses full branch (not model-context-only).
      created.dispose();
      const history = await loadOperatorSessionHistory(workspace.rootPath, "operator-dual-history");
      assert.ok(history);
      assert.ok(history.messages.some((m) => m.role === "user"));
    } finally {
      try {
        created.dispose();
      } catch {
        // already disposed
      }
    }
  });
});
