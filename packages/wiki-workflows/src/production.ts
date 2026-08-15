import { WikiProductionRuns } from "./production-run.js";
import type { WikiProducer } from "./producer-types.js";

/** Stable public factory. Production gates are fixed inside WikiProducer. */
export function createProductionWikiProducer(): WikiProducer {
  return new WikiProductionRuns();
}
