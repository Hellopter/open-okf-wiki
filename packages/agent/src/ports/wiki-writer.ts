/**
 * Wiki write port — subset of AgentRunner used by write/repair phases.
 *
 * Extracted so produce/runtime can depend on a narrow surface when only
 * writeWiki is required. Live/fixture AgentRunner implementations satisfy this.
 */

import type { AgentRunner } from "./agent-runner.js";

/** Narrow write surface: Pick of AgentRunner.writeWiki. */
export type WikiWriter = Pick<AgentRunner, "writeWiki">;

export type { WikiWriteRequest, WikiWriteResult } from "./agent-runner.js";
