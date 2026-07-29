/**
 * repair: fix blocking defects on an existing Staging Wiki (requires sealed wiki_tree).
 */

import type { PiAttemptOutcome } from "@okf-wiki/contract";
import type { AttemptHandlerContext } from "../shared.js";
import { runWriteShared } from "../write-shared.js";

export async function handleRepair(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  return runWriteShared(ctx, "repair");
}
