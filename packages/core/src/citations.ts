/**
 * Source Citation API surface (ADR 0008).
 * Implementation is split across parse + canonicalize modules; this file
 * re-exports the public names for a stable import path.
 */

export {
  type CanonicalizeCitationOptions,
  type CanonicalizeCitationResult,
  type CanonicalizeWikiTreeResult,
  canonicalizeCitationInContent,
  canonicalizeCitationTarget,
  canonicalizeWikiTreeCitations,
  countFileLines,
  formatRepoCitation,
  resolveCitationFile,
  type SourceRootMap,
  sourceRootMapFromSources,
  validateCitationResolve,
} from "./citations-canonicalize.js";
export {
  type AutofixCitationsInContentOptions,
  type AutofixCitationsInContentResult,
  type AutofixWikiTreeResult,
  type ClampCitationOptions,
  autofixCitationsInContent,
  autofixWikiTreeCitations,
  clampCitationLineRange,
} from "./citations-autofix.js";
export {
  parseSourceCitations,
  SOURCE_CITATION_RE,
  type SourceCitation,
  validateCitationFormat,
} from "./citations-parse.js";
