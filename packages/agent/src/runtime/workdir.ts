/**
 * Run workdir layout projection for Pi cwd (ADR 0032 / freeze).
 *
 * runWorkdirLayout remains for tests and tools that hand-build trees without freeze.
 */

import path from "node:path";

export type RunWorkdirLayout = {
  runWorkDir: string;
  sourcesDir: string;
  skillDir: string;
  wikiDir: string;
  analysisDir: string;
  /** sourceId → absolute path under sources/ */
  sourceMounts: Map<string, string>;
};

/** Validate and project an already-frozen Run Boundary layout. Performs no I/O. */
export function runWorkdirLayout(
  runWorkDirInput: string,
  sourceMountsInput: ReadonlyMap<string, string>,
): RunWorkdirLayout {
  const runWorkDir = path.resolve(runWorkDirInput);
  const sourcesDir = path.join(runWorkDir, "sources");
  const skillDir = path.join(runWorkDir, "skill");
  const wikiDir = path.join(runWorkDir, "wiki");
  const analysisDir = path.join(runWorkDir, "analysis");
  const sourceMounts = new Map<string, string>();
  for (const [id, mountInput] of sourceMountsInput) {
    const mount = path.resolve(mountInput);
    if (mount !== path.join(sourcesDir, id)) {
      throw new Error(`source ${id} is not mounted in the frozen Run workdir`);
    }
    sourceMounts.set(id, mount);
  }
  return {
    runWorkDir,
    sourcesDir,
    skillDir,
    wikiDir,
    analysisDir,
    sourceMounts,
  };
}

/** Relative paths the model should use in prompts. */
export function runWorkdirPromptPaths(layout: RunWorkdirLayout): string {
  const sourceLines = [...layout.sourceMounts.keys()]
    .map((id) => `  - sources/${id.replace(/[/\\]/g, "_")}/`)
    .join("\n");
  return [
    "Working directory layout (all tool paths are relative to cwd):",
    sourceLines || "  - (no sources)",
    "  - skill/          Producer Skill (read-only)",
    "  - inputs/         Projected sealed inputs (spec, evidence, defects, prior-wiki, operator-input)",
    "  - inputs/operator-input.json  Sealed operator answer when continuing after a gate",
    "  - inputs/evidence/ Research receipt index + receipts (read these before re-scan)",
    "  - wiki/           Staging Wiki (writable only in write roles)",
    "  - analysis/       Current Attempt outputs only (planner Spec and research/review receipts)",
  ].join("\n");
}
