/**
 * Test-only public surface for `@okf-wiki/agent`.
 *
 * Production code must not import this module — enforced by
 * `scripts/check-architecture.mjs`. Prefer these over poking Pi private fields.
 */

export {
  injectDurableOperatorMessages as injectDurableOperatorMessagesForTests,
  readDurableOperatorBranchMessages as readDurableOperatorBranchMessagesForTests,
} from "./session/operator-session-test-seams.js";
