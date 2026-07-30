/**
 * Attempt-local materialisation: copy sealed sources/skill into workDir,
 * project sealed semantic inputs into inputs/, chmod read-only, path asserts.
 * WikiRuns owns sealing; this mounts + projects the claim envelope.
 *
 * Phase 2: spec / research receipts / defects / prior wiki / execution plan
 * land under inputs/ (and analysis/spec.json back-compat). Transcripts are
 * audit-only and must never be copied into inputs/.
 */

import { chmod, cp, link, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AnalysisReceipt,
  AnalysisReceiptSchema,
  type FrozenRunManifest,
  FrozenRunManifestSchema,
  type PiAttemptInput,
  type RunIntent,
  RunIntentSchema,
} from "@okf-wiki/contract";
import { isPathInside, safeReceiptNodeId } from "@okf-wiki/core";
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

/**
 * Shared sealed read-only source mount (Phase 7).
 * Prefer hardlink tree so each Attempt shares sealed snapshot inodes
 * (O(file count) metadata, not O(bytes) copy). Fall back to full recursive
 * copy when hardlink fails (cross-device, permissions). Skill stays full copy
 * (small). Never introduces symlinks — assertOrdinaryTree still holds.
 */
async function hardlinkTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await hardlinkTree(src, dst);
    } else if (entry.isFile()) {
      await link(src, dst);
    } else {
      throw new Error(`non-ordinary entry in sealed tree: ${src}`);
    }
  }
}

async function copyReadOnlyTree(from: string, to: string, label: string): Promise<void> {
  if (!(await stat(from)).isDirectory()) throw new Error(`${label} must be a directory`);
  await assertOrdinaryTree(from, label);
  await cp(from, to, { recursive: true, dereference: false, errorOnExist: true });
  await assertOrdinaryTree(to, label);
  await makeTreeReadOnly(to);
}

/**
 * Mount a sealed source tree into an Attempt workDir.
 * Hardlink-first (shared sealed mount); full copy fallback for correctness.
 *
 * Hardlinked mounts must NOT chmod: hardlinks share inodes with the sealed
 * snapshot, so makeTreeReadOnly would mutate the trusted freeze. Sealed
 * sources are already read-only from freeze materialization.
 */
export async function mountSealedSourceTree(
  from: string,
  to: string,
  label: string,
): Promise<"hardlink" | "copy"> {
  if (!(await stat(from)).isDirectory()) throw new Error(`${label} must be a directory`);
  await assertOrdinaryTree(from, label);
  try {
    await hardlinkTree(from, to);
    await assertOrdinaryTree(to, label);
    // Do not chmod hardlinked trees — would mutate sealed snapshot inodes.
    return "hardlink";
  } catch {
    // Cross-device, link limit, or partial tree: wipe and full-copy (correctness first).
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    await cp(from, to, { recursive: true, dereference: false, errorOnExist: true });
    await assertOrdinaryTree(to, label);
    await makeTreeReadOnly(to);
    return "copy";
  }
}

/** Research receipt roles: exact `research` or namespaced `nodeKey:research`. */
export function isResearchInputRole(role: string): boolean {
  return role === "research" || role.endsWith(":research");
}

/** True if role is a transcript (must never land under inputs/). */
function isTranscriptRole(role: string): boolean {
  return role === "transcript" || role.endsWith(":transcript") || role === "attempt_output";
}

/**
 * Resolve a sealed artifact path to a readable file.
 * Artifacts are usually directories containing one primary file.
 */
export async function resolveSealedFile(
  readOnlyPath: string,
  preferredNames: string[] = [],
): Promise<string | undefined> {
  try {
    const info = await stat(readOnlyPath);
    if (info.isFile()) return readOnlyPath;
    if (!info.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  for (const name of preferredNames) {
    const candidate = path.join(readOnlyPath, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try next
    }
  }
  // First JSON file in the artifact dir (receipts, manifests).
  try {
    const entries = await readdir(readOnlyPath, { withFileTypes: true });
    const jsonFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();
    if (jsonFiles[0]) return path.join(readOnlyPath, jsonFiles[0]);
    // Nested analysis/spec.json etc.
    for (const sub of ["analysis", "frozen_run_manifest"]) {
      const nested = path.join(readOnlyPath, sub);
      try {
        if ((await stat(nested)).isDirectory()) {
          const found = await resolveSealedFile(nested, preferredNames);
          if (found) return found;
        }
      } catch {
        // continue
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function writeReadOnlyFile(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  await chmod(target, 0o444);
}

export type EvidenceBundleEntry = {
  handle: string;
  path: string;
  digest?: string;
  scope: string;
  summary: string;
  findingsCount: number;
  nodeId: string;
  role: string;
};

export type EvidenceBundle = {
  receipts: EvidenceBundleEntry[];
};

/**
 * Project sealed semantic inputs into workDir/inputs/ after sources+skill mount.
 * Fail closed when a required projection target cannot be resolved from a present role.
 */
async function projectSealedInputs(
  input: PiAttemptInput,
  layout: RunWorkdirLayout,
): Promise<void> {
  const inputsDir = path.join(input.workDir, "inputs");
  await mkdir(inputsDir, { recursive: true });
  await mkdir(path.join(inputsDir, "evidence", "receipts"), { recursive: true });

  const evidenceEntries: EvidenceBundleEntry[] = [];
  let intentMode: RunIntent["mode"] | undefined;
  let seededWiki = false;

  for (const sealed of input.sealedInputs) {
    // Hard-cut: never project transcripts / attempt_output into inputs/.
    if (isTranscriptRole(sealed.role)) continue;
    if (sealed.artifact.kind === "transcript") continue;

    if (sealed.role === "spec" || sealed.role === "prior_spec") {
      const file = await resolveSealedFile(sealed.readOnlyPath, [
        "spec.json",
        "analysis/spec.json",
      ]);
      if (!file) {
        if (sealed.role === "spec") {
          throw new Error("sealed spec artifact does not contain a readable spec.json");
        }
        continue;
      }
      const raw = await readFile(file, "utf8");
      // Canonical: inputs/spec.json; prior_spec only when primary absent.
      const target =
        sealed.role === "spec"
          ? path.join(inputsDir, "spec.json")
          : path.join(inputsDir, "prior-spec.json");
      if (sealed.role === "spec") {
        await writeReadOnlyFile(target, raw.endsWith("\n") ? raw : `${raw}\n`);
        // Back-compat for prompts that still read analysis/spec.json (writable — handlers may refresh).
        await mkdir(layout.analysisDir, { recursive: true });
        await writeFile(
          path.join(layout.analysisDir, "spec.json"),
          raw.endsWith("\n") ? raw : `${raw}\n`,
          "utf8",
        );
      } else if (sealed.role === "prior_spec") {
        await writeReadOnlyFile(target, raw.endsWith("\n") ? raw : `${raw}\n`);
      }
      continue;
    }

    if (sealed.role === "execution_plan") {
      const file = await resolveSealedFile(sealed.readOnlyPath, ["execution-plan.json"]);
      if (!file) throw new Error("sealed execution_plan artifact is unreadable");
      const raw = await readFile(file, "utf8");
      await writeReadOnlyFile(
        path.join(inputsDir, "execution-plan.json"),
        raw.endsWith("\n") ? raw : `${raw}\n`,
      );
      continue;
    }

    if (sealed.role === "frozen_run_manifest" || sealed.role === "manifest") {
      const file = await resolveSealedFile(sealed.readOnlyPath, [
        "frozen-run-manifest.json",
        "manifest.json",
      ]);
      if (!file) continue;
      const raw = await readFile(file, "utf8");
      await writeReadOnlyFile(
        path.join(inputsDir, "manifest.json"),
        raw.endsWith("\n") ? raw : `${raw}\n`,
      );
      try {
        const parsed = JSON.parse(raw) as unknown;
        const manifest = FrozenRunManifestSchema.safeParse(parsed);
        if (manifest.success) {
          intentMode = manifest.data.mode;
          await writeReadOnlyFile(
            path.join(inputsDir, "intent.json"),
            `${JSON.stringify(manifest.data.intent, null, 2)}\n`,
          );
        } else {
          const intentOnly = RunIntentSchema.safeParse(parsed);
          if (intentOnly.success) {
            intentMode = intentOnly.data.mode;
            await writeReadOnlyFile(
              path.join(inputsDir, "intent.json"),
              `${JSON.stringify(intentOnly.data, null, 2)}\n`,
            );
          }
        }
      } catch {
        // non-fatal: handlers can fall back to sealed path
      }
      continue;
    }

    if (sealed.role === "defects") {
      const file = await resolveSealedFile(sealed.readOnlyPath, ["defects.json"]);
      if (!file) throw new Error("sealed defects artifact is unreadable");
      const raw = await readFile(file, "utf8");
      await writeReadOnlyFile(
        path.join(inputsDir, "defects.json"),
        raw.endsWith("\n") ? raw : `${raw}\n`,
      );
      continue;
    }

    if (sealed.role === "operator_input" || sealed.artifact.kind === "operator_input") {
      const file = await resolveSealedFile(sealed.readOnlyPath, [
        "operator-input.json",
        "operator_input.json",
      ]);
      if (!file) throw new Error("sealed operator_input artifact is unreadable");
      const raw = await readFile(file, "utf8");
      await writeReadOnlyFile(
        path.join(inputsDir, "operator-input.json"),
        raw.endsWith("\n") ? raw : `${raw}\n`,
      );
      continue;
    }

    if (isResearchInputRole(sealed.role)) {
      const file = await resolveSealedFile(sealed.readOnlyPath, []);
      if (!file) {
        throw new Error(`sealed research receipt is unreadable for role ${sealed.role}`);
      }
      const raw = await readFile(file, "utf8");
      let receipt: AnalysisReceipt | undefined;
      try {
        receipt = AnalysisReceiptSchema.parse(JSON.parse(raw));
      } catch {
        // Still project bytes; index uses best-effort fields when schema fails.
      }
      const nodeId =
        receipt?.nodeId ??
        sealed.role.replace(/:research$/, "").replace(/^research$/, sealed.artifact.artifactId);
      const safe = safeReceiptNodeId(nodeId);
      const destName = `${safe}.json`;
      const destPath = path.join(inputsDir, "evidence", "receipts", destName);
      await writeReadOnlyFile(destPath, raw.endsWith("\n") ? raw : `${raw}\n`);
      // Mirror under analysis/ (writable) for back-compat listing / local tools.
      await mkdir(layout.analysisDir, { recursive: true });
      await writeFile(
        path.join(layout.analysisDir, destName),
        raw.endsWith("\n") ? raw : `${raw}\n`,
        "utf8",
      );
      evidenceEntries.push({
        handle: sealed.artifact.artifactId,
        path: `inputs/evidence/receipts/${destName}`,
        digest: sealed.artifact.digest,
        scope: receipt?.scope ?? "",
        summary: (receipt?.summary ?? "").slice(0, 500),
        findingsCount: receipt?.findings?.length ?? 0,
        nodeId,
        role: sealed.role,
      });
      continue;
    }

    if (sealed.role === "prior_wiki" || sealed.role === "wiki_tree") {
      // Mount read-only copy under inputs/prior-wiki/ when present.
      const priorMount = path.join(inputsDir, "prior-wiki");
      try {
        const info = await stat(sealed.readOnlyPath);
        if (info.isDirectory()) {
          // Only create prior-wiki mount once (prefer prior_wiki role over wiki_tree).
          if (sealed.role === "prior_wiki" || !(await dirExists(priorMount))) {
            if (await dirExists(priorMount)) {
              // Replace only when upgrading from wiki_tree to prior_wiki — skip if already prior.
            } else {
              await copyReadOnlyTree(sealed.readOnlyPath, priorMount, `sealed ${sealed.role}`);
            }
          }
          // Seed writable wiki/ for refresh / repair when not already seeded.
          if (!seededWiki && (sealed.role === "prior_wiki" || sealed.role === "wiki_tree")) {
            const wikiEmpty = await isDirEmpty(layout.wikiDir);
            if (wikiEmpty) {
              await cp(sealed.readOnlyPath, layout.wikiDir, {
                recursive: true,
                dereference: false,
                errorOnExist: false,
              });
              seededWiki = true;
            }
          }
        }
      } catch (error) {
        throw new Error(
          `sealed ${sealed.role} wiki tree is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    // sources / skill already mounted at top level — skip.
    if (sealed.role === "sources" || sealed.role === "skill") continue;
    if (sealed.artifact.kind === "snapshot_set" || sealed.artifact.kind === "skill") continue;
  }

  // Evidence index (always written so consumers have a stable path).
  const bundle: EvidenceBundle = {
    receipts: evidenceEntries.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
  };
  await writeReadOnlyFile(
    path.join(inputsDir, "evidence", "index.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );

  // Refresh fail-closed: mode refresh requires prior wiki projection.
  if (intentMode === "refresh") {
    const hasPrior =
      (await dirExists(path.join(inputsDir, "prior-wiki"))) ||
      input.sealedInputs.some((s) => s.role === "prior_wiki" || s.role === "wiki_tree");
    if (!hasPrior) {
      throw new Error(
        "refresh mode requires a sealed prior_wiki (or wiki_tree) input; freeze must pin the published wiki",
      );
    }
  }

  // Mark inputs tree read-only at the root (files already 0444).
  try {
    await chmod(path.join(inputsDir, "evidence"), 0o555);
    await chmod(path.join(inputsDir, "evidence", "receipts"), 0o555);
    await chmod(inputsDir, 0o555);
  } catch {
    // best-effort on platforms that restrict dir chmod
  }
}

async function dirExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isDirEmpty(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory);
    return entries.length === 0;
  } catch {
    return true;
  }
}

/** Load EvidenceBundle from projected inputs/evidence/index.json. */
export async function loadEvidenceBundle(
  layout: RunWorkdirLayout,
): Promise<EvidenceBundle | undefined> {
  const indexPath = path.join(layout.runWorkDir, "inputs", "evidence", "index.json");
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as EvidenceBundle;
    if (!parsed || !Array.isArray(parsed.receipts)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Load RunIntent from projected inputs/intent.json or inputs/manifest.json. */
export async function loadProjectedIntent(
  layout: RunWorkdirLayout,
): Promise<RunIntent | undefined> {
  for (const rel of ["inputs/intent.json", "inputs/manifest.json"]) {
    const candidate = path.join(layout.runWorkDir, rel);
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      const intentOnly = RunIntentSchema.safeParse(raw);
      if (intentOnly.success) return intentOnly.data;
      const manifest = FrozenRunManifestSchema.safeParse(raw);
      if (manifest.success) return RunIntentSchema.parse(manifest.data.intent);
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Load defects JSON text from inputs/defects.json when projected. */
export async function loadProjectedDefectsText(
  layout: RunWorkdirLayout,
): Promise<string | undefined> {
  const candidate = path.join(layout.runWorkDir, "inputs", "defects.json");
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return undefined;
  }
}

/** Load sealed operator answer from inputs/operator-input.json when projected. */
export async function loadProjectedOperatorInput(
  layout: RunWorkdirLayout,
): Promise<{ answer: string; gateId?: string; parentAttemptId?: string } | undefined> {
  const candidate = path.join(layout.runWorkDir, "inputs", "operator-input.json");
  try {
    const raw = await readFile(candidate, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    const answer = typeof row.answer === "string" ? row.answer.trim() : "";
    if (!answer) return undefined;
    return {
      answer,
      ...(typeof row.gateId === "string" && row.gateId.trim()
        ? { gateId: row.gateId.trim() }
        : {}),
      ...(typeof row.parentAttemptId === "string" && row.parentAttemptId.trim()
        ? { parentAttemptId: row.parentAttemptId.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Prompt block for a sealed operator answer (Phase 4 continuation Attempt).
 * Place early so truncation does not drop the fact.
 */
export function formatOperatorInputNotes(
  operatorInput: { answer: string } | undefined,
): string | undefined {
  const answer = operatorInput?.answer?.trim();
  if (!answer) return undefined;
  return `Operator answer (sealed fact from prior gate; treat as authoritative):\n${answer}`;
}

/**
 * Merge RunIntent focus with a sealed operator answer for planner/worker notes.
 * Operator answer wins when both are present (more specific continuation fact).
 */
export function mergeOperatorNotes(parts: {
  focus?: string;
  operatorAnswer?: string;
}): string | undefined {
  const focus = parts.focus?.trim() || undefined;
  const answer = parts.operatorAnswer?.trim() || undefined;
  if (answer && focus) {
    return `Operator answer (authoritative):\n${answer}\n\nOperator-requested focus:\n${focus}`;
  }
  if (answer) return `Operator answer (authoritative):\n${answer}`;
  if (focus) return focus;
  return undefined;
}

/** Format evidence index for writer/domain prompts. */
export function formatEvidenceIndex(bundle: EvidenceBundle | undefined): string {
  if (!bundle || bundle.receipts.length === 0) {
    return "No research receipts were projected under inputs/evidence/.";
  }
  const lines = [
    `Projected ${bundle.receipts.length} research receipt(s) under inputs/evidence/receipts/:`,
    ...bundle.receipts.map((r) => {
      const scope = r.scope ? ` scope=${r.scope}` : "";
      const summary = r.summary ? ` — ${r.summary.slice(0, 200)}` : "";
      return `- ${r.nodeId} (${r.path})${scope} findings=${r.findingsCount}${summary}`;
    }),
    "Read receipt JSON files directly; prefer synthesizing from them over re-scanning sources.",
  ];
  return lines.join("\n");
}

/** Mount sealed sources + skill under workDir; project semantic inputs; create wiki/analysis. */
export async function materializeInputs(input: PiAttemptInput): Promise<RunWorkdirLayout> {
  assertAttemptPaths(input);
  await mkdir(input.workDir, { recursive: true });
  const sourceMounts = new Map<string, string>();
  for (const [sourceId, sourcePath] of Object.entries(input.sourcePaths)) {
    assertSealedSource(input, sourcePath);
    const mount = path.join(input.workDir, "sources", sourceId);
    await mkdir(path.dirname(mount), { recursive: true });
    // Phase 7: shared sealed read-only source mount (hardlink; copy fallback).
    await mountSealedSourceTree(sourcePath, mount, `sealed source ${sourceId}`);
    sourceMounts.set(sourceId, mount);
  }
  assertSealedSkill(input);
  // Skill is small; full copy keeps isolation simple.
  await copyReadOnlyTree(input.skillPath, path.join(input.workDir, "skill"), "sealed skill");
  await mkdir(path.join(input.workDir, "wiki"), { recursive: true });
  await mkdir(path.join(input.workDir, "analysis"), { recursive: true });
  const layout = runWorkdirLayout(input.workDir, sourceMounts);
  await projectSealedInputs(input, layout);
  return layout;
}

// Re-export type for consumers.
export type { FrozenRunManifest, RunIntent };
