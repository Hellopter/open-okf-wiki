/**
 * Attempt-local materialisation: copy sealed sources/skill into workDir,
 * chmod read-only, path asserts. WikiRuns owns sealing; this only mounts.
 */

import { chmod, cp, lstat, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptInput } from "@okf-wiki/contract";
import { isPathInside } from "@okf-wiki/core";
import { type RunWorkdirLayout, runWorkdirLayout } from "../workdir.js";

export function assertAttemptPaths(input: PiAttemptInput): void {
  if (!isPathInside(input.attemptDir, input.workDir)) {
    throw new Error("attempt workDir must be inside attemptDir");
  }
  if (!isPathInside(input.attemptDir, input.sessionPath)) {
    throw new Error("attempt sessionPath must be inside attemptDir");
  }
}

function assertSealedSource(input: PiAttemptInput, sourcePath: string): void {
  if (
    !input.sealedInputs.some(
      (item) =>
        item.artifact.kind === "snapshot_set" && isPathInside(item.readOnlyPath, sourcePath),
    )
  ) {
    throw new Error(`source input is not under a sealed snapshot artifact: ${sourcePath}`);
  }
}

function assertSealedSkill(input: PiAttemptInput): void {
  if (
    !input.sealedInputs.some(
      (item) => item.artifact.kind === "skill" && isPathInside(item.readOnlyPath, input.skillPath),
    )
  ) {
    throw new Error("skill input is not under a sealed skill artifact");
  }
}

async function assertOrdinaryTree(directory: string, label: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(`${label} contains a non-ordinary filesystem entry: ${child}`);
    }
    if (info.isDirectory()) await assertOrdinaryTree(child, label);
  }
}

async function makeTreeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(child);
    else await chmod(child, 0o444);
  }
  await chmod(directory, 0o555);
}

async function copyReadOnlyTree(from: string, to: string, label: string): Promise<void> {
  if (!(await stat(from)).isDirectory()) throw new Error(`${label} must be a directory`);
  await assertOrdinaryTree(from, label);
  await cp(from, to, { recursive: true, dereference: false, errorOnExist: true });
  await assertOrdinaryTree(to, label);
  await makeTreeReadOnly(to);
}

/** Mount sealed sources + skill under workDir; create wiki/analysis dirs. */
export async function materializeInputs(input: PiAttemptInput): Promise<RunWorkdirLayout> {
  assertAttemptPaths(input);
  await mkdir(input.workDir, { recursive: true });
  const sourceMounts = new Map<string, string>();
  for (const [sourceId, sourcePath] of Object.entries(input.sourcePaths)) {
    assertSealedSource(input, sourcePath);
    const mount = path.join(input.workDir, "sources", sourceId);
    await mkdir(path.dirname(mount), { recursive: true });
    await copyReadOnlyTree(sourcePath, mount, `sealed source ${sourceId}`);
    sourceMounts.set(sourceId, mount);
  }
  assertSealedSkill(input);
  await copyReadOnlyTree(input.skillPath, path.join(input.workDir, "skill"), "sealed skill");
  await mkdir(path.join(input.workDir, "wiki"), { recursive: true });
  await mkdir(path.join(input.workDir, "analysis"), { recursive: true });
  return runWorkdirLayout(input.workDir, sourceMounts);
}
