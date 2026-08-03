/**
 * write.root: produce (or feedback-repair) the Staging Wiki tree.
 */

import type { PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import type { AttemptHandlerContext } from "../shared.js";
import { runWriteShared } from "../write-shared.js";

export async function handleWriteRoot(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  if (ctx.input.node.key !== "write.root") {
    throw new Error(`unsupported Pi attempt node: ${ctx.input.node.kind}/${ctx.input.node.key}`);
  }
  return runWriteShared(ctx, "write.root");
}
