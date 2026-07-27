/**
 * Skill-aligned prompts for wiki_produce-orchestrated Pi Produce (ADR 0032).
 */

export { domainResearchPrompt } from "./domain.js";
export { leafResearchPrompt } from "./leaf.js";
export { plannerPrompt } from "./plan.js";
export {
  PLAN_SCOUT_KINDS,
  planScoutPrompt,
  type PlanScoutKind,
} from "./plan-scout.js";
export { reviewerPrompt, type ReviewLens } from "./reviewer.js";
export {
  domainList,
  pageList,
  typeForTemplate,
  type WikiLanguage,
} from "./system.js";
export { rootWritePrompt, rootWriteSystemPrompt } from "./writer.js";
