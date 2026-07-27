import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildWikiScopedToolDefinitions } from "./fs-operations.js";

describe("Pi file tool definitions", () => {
  it("enforce relative contained paths, Source Ignores, symlinks, and write scope", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-tools-"));
    const workdir = path.join(tmp, "run");
    const outside = path.join(tmp, "outside");

    try {
      await mkdir(path.join(workdir, "sources", "repo", "ignored"), { recursive: true });
      await mkdir(path.join(workdir, "wiki"), { recursive: true });
      await mkdir(path.join(workdir, "analysis"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(
        path.join(workdir, "sources", "repo", "visible.ts"),
        "export const ok = true;\n",
      );
      await writeFile(path.join(workdir, "sources", "repo", "ignored", "secret.ts"), "secret\n");
      await writeFile(path.join(outside, "secret.ts"), "outside\n");
      await symlink(outside, path.join(workdir, "sources", "repo", "escape"), "dir");
      await symlink(outside, path.join(workdir, "wiki", "escape"), "dir");

      const definitions = buildWikiScopedToolDefinitions({
        runWorkDir: workdir,
        mayWrite: true,
        sourceIgnores: new Map([["repo", ["ignored/**"]]]),
      });
      const tools = new Map(definitions.map((definition) => [definition.name, definition]));
      const execute = async (name: string, input: Record<string, unknown>) => {
        const definition = tools.get(name);
        assert.ok(definition, `missing ${name} definition`);
        const run = definition.execute as unknown as (
          toolCallId: string,
          args: Record<string, unknown>,
        ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
        return run("test-call", input);
      };

      await assert.doesNotReject(() => execute("read", { path: "sources/repo/visible.ts" }));
      await assert.rejects(
        () => execute("read", { path: path.join(workdir, "sources", "repo", "visible.ts") }),
        /relative|absolute/i,
      );
      await assert.rejects(() => execute("read", { path: "../outside/secret.ts" }), /escape|\.\./i);
      await assert.rejects(
        () => execute("read", { path: "sources/repo/escape/secret.ts" }),
        /symlink|escape|workdir/i,
      );
      await assert.rejects(
        () => execute("read", { path: "sources/repo/ignored/secret.ts" }),
        /ignored/i,
      );

      await assert.rejects(
        () => execute("ls", { path: "sources/repo/escape" }),
        /symlink|escape|not found|workdir/i,
      );
      await assert.rejects(
        () => execute("grep", { pattern: "outside", path: "sources/repo/escape" }),
        /symlink|escape|not found|workdir/i,
      );
      const lsResult = await execute("ls", { path: "sources/repo" });
      const lsText = lsResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.doesNotMatch(lsText, /ignored/);
      const grepResult = await execute("grep", { pattern: "secret", path: "sources/repo" });
      const grepText = grepResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.doesNotMatch(grepText, /ignored|secret\.ts/);
      await assert.rejects(
        () => execute("find", { pattern: "*.ts", path: "sources/repo/escape" }),
        /symlink|escape|not found|workdir/i,
      );
      const findResult = await execute("find", { pattern: "**/*.ts", path: "sources/repo" });
      const findText = findResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.match(findText, /visible\.ts/);
      assert.doesNotMatch(findText, /ignored|secret\.ts|escape/);

      await assert.rejects(
        () => execute("write", { path: path.join(workdir, "wiki", "absolute.md"), content: "no" }),
        /relative|absolute/i,
      );
      await assert.rejects(
        () => execute("write", { path: "../outside/new.md", content: "no" }),
        /escape|\.\./i,
      );
      await assert.rejects(
        () => execute("write", { path: "wiki/escape/new.md", content: "no" }),
        /symlink|escape|workdir/i,
      );
      await assert.rejects(
        () =>
          execute("edit", {
            path: "wiki/escape/secret.ts",
            edits: [{ oldText: "outside", newText: "changed" }],
          }),
        /symlink|escape|workdir|could not edit/i,
      );
      await assert.rejects(
        () => execute("write", { path: "sources/repo/no.md", content: "no" }),
        /read-only|wiki\/ or analysis/i,
      );
      await assert.doesNotReject(() => execute("write", { path: "wiki/ok.md", content: "ok\n" }));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
