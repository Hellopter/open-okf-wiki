import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  digestPublicationTree,
  digestPublicationTreeContentOnly,
  EMPTY_PUBLICATION_DIGEST,
  manifestPublicationTree,
} from "./digest.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

function page(title: string, body = "Hello.", type = "Concept"): string {
  return `---\ntype: ${type}\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

test("manifestPublicationTree is sort-stable, posix-relative, and symlink fail-closed", async () => {
  const root = await tempDir("okf-pub-manifest-");
  await writeMd(root, "z-last.md", page("Z"));
  await writeMd(root, "a-first.md", page("A"));
  await writeMd(root, "nested/b.md", page("B"));
  await writeFile(path.join(root, "plain.txt"), "bytes\n", "utf8");

  const first = await manifestPublicationTree(root);
  const second = await manifestPublicationTree(root);
  assert.deepEqual(first, second);
  assert.equal(first.schema, 1);
  assert.deepEqual(
    first.files.map((f) => f.path),
    ["a-first.md", "nested/b.md", "plain.txt", "z-last.md"],
  );
  for (const file of first.files) {
    assert.equal(file.path.includes("\\"), false, `path must be posix-relative: ${file.path}`);
    assert.equal(file.digest.length, 64);
    assert.ok(file.size > 0);
  }
  assert.equal(await digestPublicationTree(root), await digestPublicationTree(root));
  assert.equal(await digestPublicationTree(undefined), EMPTY_PUBLICATION_DIGEST);
  assert.equal(await digestPublicationTree(path.join(root, "missing")), EMPTY_PUBLICATION_DIGEST);

  const linkTarget = path.join(root, "plain.txt");
  const linkPath = path.join(root, "link.txt");
  try {
    await symlink(linkTarget, linkPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
    throw error;
  }
  await assert.rejects(() => manifestPublicationTree(root), /non-ordinary entry|symlink/i);
});

test("digestPublicationTreeContentOnly ignores seal sidecar", async () => {
  const root = await tempDir("okf-pub-content-only-");
  await writeMd(root, "overview.md", page("Overview"));
  const contentDigest = await digestPublicationTree(root);
  await writeFile(
    path.join(root, ".okf-artifact-manifest.json"),
    `${JSON.stringify({ schema: 1 })}\n`,
    "utf8",
  );
  assert.notEqual(await digestPublicationTree(root), contentDigest);
  assert.equal(await digestPublicationTreeContentOnly(root), contentDigest);
});
