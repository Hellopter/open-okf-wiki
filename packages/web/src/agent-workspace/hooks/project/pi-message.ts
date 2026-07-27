/**
 * Pi → AgentMessage content helpers.
 *
 * Canonical implementation lives in `@okf-wiki/contract` so web, agent, and
 * server share one pure parse path without a web→agent dependency.
 */

export {
  assistantFromSnapshot,
  extractPartsFromMessage,
  extractToolCallsFromMessage,
  messageRole,
  patchToolsOnAssistant,
  piMessageId,
  wikiProduceDetails,
} from "@okf-wiki/contract";
