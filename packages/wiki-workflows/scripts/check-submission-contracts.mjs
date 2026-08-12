#!/usr/bin/env node
/**
 * Contract field alignment check.
 *
 * Ensures model-facing field constants in `src/submissions/contracts.ts`
 * stay aligned with the `assertExactKeys` lists enforced by parsers in
 * `src/control-submissions.ts`.
 *
 * Exit 0 on match; exit 1 with a clear message on mismatch.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_PATH = join(ROOT, "src/submissions/contracts.ts");
const CONTROL_PATH = join(ROOT, "src/control-submissions.ts");

/** @param {string} source */
function parseStringArrayConst(source, name) {
  const re = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as\\s+const`,
    "m",
  );
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not find export const ${name} = [...] as const in contracts.ts`);
  }
  return parseStringLiterals(match[1]);
}

/** @param {string} body */
function parseStringLiterals(body) {
  const values = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    values.push(m[1] ?? m[2]);
  }
  return values;
}

/**
 * Extract assertExactKeys string-list arguments inside a named function body.
 * Returns an array of { keys, label } in source order.
 *
 * @param {string} source
 * @param {string} fnName
 */
function parseAssertExactKeysInFunction(source, fnName) {
  const fnRe = new RegExp(
    `export\\s+function\\s+${fnName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`,
    "m",
  );
  const start = source.match(fnRe);
  if (!start || start.index === undefined) {
    throw new Error(`Could not find export function ${fnName} in control-submissions.ts`);
  }
  const bodyStart = start.index + start[0].length;
  const body = extractBalancedBlock(source, bodyStart - 1);
  const calls = [];
  const callRe = /assertExactKeys\s*\(\s*[^,]+,\s*\[([^\]]*)\]\s*,\s*"([^"]*)"\s*\)/g;
  let m;
  while ((m = callRe.exec(body)) !== null) {
    calls.push({ keys: parseStringLiterals(m[1]), label: m[2] });
  }
  if (calls.length === 0) {
    throw new Error(`No assertExactKeys calls found inside ${fnName}`);
  }
  return calls;
}

/**
 * Given source and the index of an opening `{`, return the full block including braces.
 * @param {string} source
 * @param {number} openIndex
 */
function extractBalancedBlock(source, openIndex) {
  if (source[openIndex] !== "{") {
    throw new Error(`Expected '{' at index ${openIndex}`);
  }
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error("Unbalanced braces while extracting function body");
}

/** @param {string[]} a @param {string[]} b */
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** @param {string[]} subset @param {string[]} superset */
function isSubset(subset, superset) {
  const set = new Set(superset);
  return subset.every((k) => set.has(k));
}

/** @param {string[]} a @param {string[]} b */
function formatList(a) {
  return JSON.stringify(a);
}

/**
 * @param {string} name
 * @param {string[]} contract
 * @param {string[]} control
 * @param {"equal" | "subset"} mode
 * @param {string[]} errors
 */
function checkAlignment(name, contract, control, mode, errors) {
  if (mode === "equal") {
    if (!sameSet(contract, control)) {
      errors.push(
        `${name}: contracts ${formatList(contract)} !== control-submissions ${formatList(control)}`,
      );
    }
    return;
  }
  // subset: contract fields must all appear in control required keys
  if (!isSubset(contract, control)) {
    const missing = contract.filter((k) => !control.includes(k));
    errors.push(
      `${name}: RESEARCH/contract fields ${formatList(contract)} are not ⊆ control keys ${formatList(control)} (missing: ${formatList(missing)})`,
    );
  }
  // Prefer exact equality when both sides are top-level required sets
  if (!sameSet(contract, control)) {
    // Soft note only when subset holds but not equal — still fail for top-level research
    // so drift (extra control keys not in contracts) is visible.
    errors.push(
      `${name}: contracts ${formatList(contract)} and control-submissions ${formatList(control)} differ (expected equal sets)`,
    );
  }
}

function main() {
  const contractsSrc = readFileSync(CONTRACTS_PATH, "utf8");
  const controlSrc = readFileSync(CONTROL_PATH, "utf8");

  const researchArtifact = parseStringArrayConst(contractsSrc, "RESEARCH_ARTIFACT_FIELDS");
  const researchFinding = parseStringArrayConst(contractsSrc, "RESEARCH_FINDING_FIELDS");
  const researchGap = parseStringArrayConst(contractsSrc, "RESEARCH_GAP_FIELDS");
  const synthesisFinalize = parseStringArrayConst(contractsSrc, "SYNTHESIS_FINALIZE_FIELDS");
  const reviewResult = parseStringArrayConst(contractsSrc, "REVIEW_RESULT_FIELDS");
  const reviewLocal = parseStringArrayConst(contractsSrc, "REVIEW_LOCAL_DEFECT_FIELDS");
  const reviewStructural = parseStringArrayConst(contractsSrc, "REVIEW_STRUCTURAL_DEFECT_FIELDS");

  const researchCalls = parseAssertExactKeysInFunction(controlSrc, "parseResearchSubmission");
  const synthesisCalls = parseAssertExactKeysInFunction(controlSrc, "parseSynthesisSubmission");
  const reviewCalls = parseAssertExactKeysInFunction(controlSrc, "parseReviewSubmission");

  /** @param {{keys:string[],label:string}[]} calls @param {string} labelPart */
  function keysForLabel(calls, labelPart) {
    const hit = calls.find((c) => c.label.includes(labelPart));
    if (!hit) {
      throw new Error(`No assertExactKeys label containing ${JSON.stringify(labelPart)}`);
    }
    return hit.keys;
  }

  const errors = [];

  // Research top-level: contracts RESEARCH_ARTIFACT_FIELDS must equal (and ⊆) parseResearchSubmission keys.
  const researchTop = keysForLabel(researchCalls, "Research submission");
  checkAlignment("RESEARCH_ARTIFACT_FIELDS ↔ parseResearchSubmission", researchArtifact, researchTop, "equal", errors);

  // Nested research shapes
  const findingKeys = keysForLabel(researchCalls, "Research finding");
  checkAlignment("RESEARCH_FINDING_FIELDS ↔ Research finding", researchFinding, findingKeys, "equal", errors);

  const gapKeys = keysForLabel(researchCalls, "Research gap");
  checkAlignment("RESEARCH_GAP_FIELDS ↔ Research gap", researchGap, gapKeys, "equal", errors);

  // Synthesis top-level result
  const finalizeKeys = keysForLabel(synthesisCalls, "Final synthesis");
  checkAlignment("SYNTHESIS_FINALIZE_FIELDS ↔ Final synthesis", synthesisFinalize, finalizeKeys, "equal", errors);

  // Review top-level + defects
  const reviewTop = keysForLabel(reviewCalls, "Reviewer submission");
  checkAlignment("REVIEW_RESULT_FIELDS ↔ Reviewer submission", reviewResult, reviewTop, "equal", errors);

  const localKeys = keysForLabel(reviewCalls, "Local review defect");
  checkAlignment("REVIEW_LOCAL_DEFECT_FIELDS ↔ Local review defect", reviewLocal, localKeys, "equal", errors);

  const structuralKeys = keysForLabel(reviewCalls, "Structural review defect");
  checkAlignment(
    "REVIEW_STRUCTURAL_DEFECT_FIELDS ↔ Structural review defect",
    reviewStructural,
    structuralKeys,
    "equal",
    errors,
  );

  if (errors.length > 0) {
    console.error("Submission contract alignment check FAILED:\n");
    for (const err of errors) {
      console.error(`  • ${err}`);
    }
    console.error(
      "\nUpdate src/submissions/contracts.ts and/or src/control-submissions.ts so field lists match.",
    );
    process.exit(1);
  }

  console.log("Submission contract alignment check passed.");
  console.log(`  RESEARCH_ARTIFACT_FIELDS = ${formatList(researchArtifact)}`);
  console.log(`  parseResearchSubmission  = ${formatList(researchTop)}`);
  console.log(`  SYNTHESIS finalize and REVIEW fields also match.`);
}

try {
  main();
} catch (error) {
  console.error(`Submission contract alignment check ERROR: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
