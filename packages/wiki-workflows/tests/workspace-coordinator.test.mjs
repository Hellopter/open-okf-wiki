import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWikiWorkspaceCoordinator } from "../dist/workspace-coordinator.js";

test("workspace coordinator serializes owners and releases only matching tokens", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-owner-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const first = createWikiWorkspaceCoordinator(workspace);
  const second = createWikiWorkspaceCoordinator(workspace);
  const lock = await first.acquire("run-1");
  assert.ok(lock);
  assert.equal(await second.acquire("run-2"), undefined);
  await second.release({ workspace, owner: { ...lock.owner, token: "not-owner" } });
  assert.equal((await first.currentOwner())?.runId, "run-1");
  const ownerCredential = await readFile(path.join(workspace, ".okf-wiki", "active.lock"), "utf8");
  await first.updateRun(lock, "run-updated");
  assert.equal((await second.currentOwner())?.runId, "run-updated");
  assert.equal(await readFile(path.join(workspace, ".okf-wiki", "active.lock"), "utf8"), ownerCredential,
    "run metadata updates must not replace the ownership credential");
  await first.release(lock);
  assert.ok(await second.acquire("run-2"));
});

test("workspace coordinator has one winner under concurrent acquisition", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-owner-race-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    createWikiWorkspaceCoordinator(workspace).acquire(`run-${index}`)));
  assert.equal(results.filter(Boolean).length, 1);
});

test("workspace coordinator fails closed on malformed locks and recovers dead-pid locks", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-owner-stale-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const stateDirectory = path.join(workspace, ".okf-wiki");
  const lockFile = path.join(stateDirectory, "active.lock");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(lockFile, "broken\n");
  const coordinator = createWikiWorkspaceCoordinator(workspace);
  const malformed = await coordinator.acquire("recovered-malformed");
  assert.equal(malformed, undefined);
  await rm(lockFile);

  await writeFile(lockFile, JSON.stringify({
    version: 1, pid: 2_147_483_647, token: "dead", runId: "dead-run", createdAt: new Date().toISOString(),
  }));
  const dead = await coordinator.acquire("recovered-dead");
  assert.ok(dead);
  assert.equal(JSON.parse(await readFile(lockFile, "utf8")).runId, "recovered-dead");
});

test("workspace coordinator excludes a live child process and reclaims its lock after exit", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-owner-process-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/workspace-coordinator.js");
  const script = [
    `import { createWikiWorkspaceCoordinator } from ${JSON.stringify(modulePath)};`,
    `const coordinator = createWikiWorkspaceCoordinator(${JSON.stringify(workspace)});`,
    `const lock = await coordinator.acquire("child-run");`,
    `if (!lock) process.exit(2);`,
    `process.stdout.write("ready\\n");`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");

  const parent = createWikiWorkspaceCoordinator(workspace);
  assert.equal(await parent.acquire("parent-while-live"), undefined);
  assert.equal((await parent.currentOwner())?.runId, "child-run");

  child.kill("SIGTERM");
  await once(child, "exit");
  const recovered = await parent.acquire("parent-after-exit");
  assert.ok(recovered);
  assert.equal((await parent.currentOwner())?.runId, "parent-after-exit");
});
