/**
 * Workflow projection of freeze output into Run workdir layout.
 */

import type { FrozenRunBoundary } from "@okf-wiki/core";
import { type RunWorkdirLayout, runWorkdirLayout } from "../runtime/workdir.js";

export type { RunWorkdirLayout };

/** Project freeze output into the layout Produce/plan use. */
export function layoutFromFrozen(frozen: FrozenRunBoundary): RunWorkdirLayout {
  return runWorkdirLayout(frozen.runWorkDir, frozen.sourcePathMap);
}
