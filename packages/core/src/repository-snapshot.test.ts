import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { GitRunner } from "./git-runner.js";
import { materializeRepositorySnapshot } from "./repository-snapshot.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("materializeRepositorySnapshot uses runner for read-tree and checkout-index", async () => {
  const root = await tempDir("okf-snap-fake-");
  try {
    const repo = path.join(root, "repo");
    const dest = path.join(root, "snapshot");
    await mkdir(repo, { recursive: true });

    const calls: Array<{ cwd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const fake: GitRunner = async (cwd, args, opts) => {
      calls.push({ cwd, args, env: opts?.env });
      if (args[0] === "read-tree") {
        assert.equal(args[1], "abc123");
        assert.ok(opts?.env?.GIT_INDEX_FILE);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("checkout-index")) {
        // Simulate checkout-index writing ordinary files under --prefix=
        const prefixArg = args.find((a) => a.startsWith("--prefix="));
        assert.ok(prefixArg);
        const prefix = prefixArg.slice("--prefix=".length);
        await mkdir(prefix, { recursive: true });
        await writeFile(path.join(prefix, "README.md"), "# snap\n", "utf8");
        await writeFile(path.join(prefix, "keep.txt"), "keep\n", "utf8");
        await writeFile(path.join(prefix, "noise.log"), "noise\n", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected git args: ${args.join(" ")}` };
    };

    await materializeRepositorySnapshot(
      {
        repositoryPath: repo,
        revision: "abc123",
        destination: dest,
        effectiveIgnores: ["*.log"],
      },
      fake,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.args[0], "read-tree");
    assert.ok(calls[1]?.args.includes("checkout-index"));
    assert.ok(calls[1]?.args.includes("core.symlinks=false"));

    const names = await readdir(dest);
    assert.ok(names.includes("README.md"));
    assert.ok(names.includes("keep.txt"));
    assert.ok(!names.includes("noise.log"));

    const body = await readFile(path.join(dest, "README.md"), "utf8");
    assert.equal(body, "# snap\n");

    // Tree is read-only after success.
    await assert.rejects(() => writeFile(path.join(dest, "new.txt"), "x"), /EACCES|EPERM|EROFS/i);
  } finally {
    // makeTreeReadOnly may leave dirs non-writable; force remove via chmod path is in product.
    await rm(root, { recursive: true, force: true }).catch(async () => {
      const { makeTreeWritable } = await import("./immutable-tree.js");
      await makeTreeWritable(root).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
  }
});

test("materializeRepositorySnapshot fails closed when read-tree fails", async () => {
  const root = await tempDir("okf-snap-fail-");
  try {
    const repo = path.join(root, "repo");
    const dest = path.join(root, "snapshot");
    await mkdir(repo, { recursive: true });

    const fake: GitRunner = async (_cwd, args) => {
      if (args[0] === "read-tree") {
        return { code: 128, stdout: "", stderr: "fatal: not a tree" };
      }
      return { code: 1, stdout: "", stderr: "should not reach" };
    };

    await assert.rejects(
      () =>
        materializeRepositorySnapshot(
          {
            repositoryPath: repo,
            revision: "missing",
            destination: dest,
            effectiveIgnores: [],
          },
          fake,
        ),
      /read-tree failed/,
    );

    await assert.rejects(() => access(dest), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materializeRepositorySnapshot fails closed when checkout-index fails", async () => {
  const root = await tempDir("okf-snap-co-fail-");
  try {
    const repo = path.join(root, "repo");
    const dest = path.join(root, "snapshot");
    await mkdir(repo, { recursive: true });

    const fake: GitRunner = async (_cwd, args) => {
      if (args[0] === "read-tree") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "checkout failed" };
    };

    await assert.rejects(
      () =>
        materializeRepositorySnapshot(
          {
            repositoryPath: repo,
            revision: "abc",
            destination: dest,
            effectiveIgnores: [],
          },
          fake,
        ),
      /checkout-index failed/,
    );

    await assert.rejects(() => access(dest), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materializeRepositorySnapshot aborts a Git operation and removes its partial tree", async () => {
  const root = await tempDir("okf-snap-abort-");
  try {
    const repo = path.join(root, "repo");
    const dest = path.join(root, "snapshot");
    await mkdir(repo, { recursive: true });
    const controller = new AbortController();
    const fake: GitRunner = async (_cwd, _args, opts) =>
      new Promise((_, reject) => {
        if (opts?.signal?.aborted) {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }
        opts?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });

    const materializing = materializeRepositorySnapshot(
      {
        repositoryPath: repo,
        revision: "abc",
        destination: dest,
        effectiveIgnores: [],
        signal: controller.signal,
      },
      fake,
    );
    controller.abort();
    await assert.rejects(materializing, (error: unknown) => (error as Error).name === "AbortError");
    await assert.rejects(() => access(dest), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
