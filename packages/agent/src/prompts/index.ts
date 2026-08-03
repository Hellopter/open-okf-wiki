/**
 * Skill-aligned prompts for WikiRuns Attempt-local Pi work (ADR 0035).
 */

export { domainResearchPrompt } from "./domain.js";
export { leafResearchPrompt } from "./leaf.js";
export { plannerPrompt } from "./plan.js";
export {
  PLAN_SCOUT_KINDS,
  type PlanScoutKind,
  planScoutPrompt,
  planScoutPromptLegacy,
  THEMATIC_SCOUT_KINDS,
  type PlanScoutTask,
  type ThematicScoutKind,
  scoutTaskFileSlug,
  scoutTaskLabel,
} from "./plan-scout.js";
export { type ReviewLens, reviewerPrompt } from "./reviewer.js";
export {
  domainList,
  pageList,
  typeForTemplate,
  type WikiLanguage,
} from "./system.js";
export { rootWritePrompt, rootWriteSystemPrompt } from "./writer.js";
