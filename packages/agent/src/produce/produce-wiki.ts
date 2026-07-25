/**
 * Compatibility re-export of workflow produce entry.
 * Prefer `import { produceWiki } from "../workflow/produce.js"` (or package-relative
 * workflow path) for new call sites. Kept for external/test imports that still
 * resolve via produce/produce-wiki.
 */

export {
  produceWiki,
  repairWiki,
  type ProduceWikiInput,
  type ProduceWikiModels,
  type ProduceWikiResult,
  type RepairWikiInput,
  type RepairWikiResult,
} from "../workflow/produce.js";
