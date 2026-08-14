/**
 * Wiki validation surface: re-exports focused modules for backward compatibility.
 *
 * Prefer importing from wiki-validate / wiki-indexes / wiki-finalize when adding
 * new call sites; this barrel keeps dist/validate.js stable for tests and engine.
 */
export {
  validateWiki,
  validateWikiPage,
  validateWikiPageContent,
  canonicalizeWikiPageContent,
  validateWikiCandidate,
  resolveWikiRoots,
  specPagePaths,
  derivedIndexPaths,
  type ResolvedWikiRoots,
} from "./wiki-validate.js";
export { materializeWikiIndexes, validateWikiIndexes, renderWikiIndex } from "./wiki-indexes.js";
export { finalizeWiki, materializeValidatedWikiIndexes } from "./wiki-finalize.js";
export { WikiValidationInfrastructureError } from "./failures.js";
