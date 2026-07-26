/**
 * Operator / plan tool factories (ToolDefinition edge only).
 */

import { createSubmitWikiRunSpecTool } from "./submit-wiki-run-spec.js";

export {
  createSessionStatusTool,
  SESSION_STATUS_TOOL_NAME,
} from "./session-status.js";
export {
  createSubmitWikiRunSpecTool,
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
} from "./submit-wiki-run-spec.js";
export {
  type CreateWikiProduceToolInput,
  createWikiProduceTool,
  WIKI_PRODUCE_TOOL_NAME,
} from "./wiki-produce.js";
export {
  type CreateWikiRepairToolInput,
  createWikiRepairTool,
  WIKI_REPAIR_TOOL_NAME,
} from "./wiki-repair.js";

/** Plan-phase custom tools factory for wiki_produce → runWiki injection. */
export function createPlanTools(runWorkDir: string): readonly unknown[] {
  return [createSubmitWikiRunSpecTool({ runWorkDir })];
}
