/**
 * Deterministic publishability scoring for Staging Wiki.
 * Single policy surface used by Produce hard-score.
 */

import { type DefectSeverity, type MergedDefectReport, type WikiRunSpec } from "@okf-wiki/contract";
import { scanWikiTree, validateWikiIndexes, validateWikiTree } from "@okf-wiki/core";
import { hasBlockingDefects, readMergedDefects } from "./defects.js";

export type PublishabilityResult = {
  publishable: boolean;
  reasons: string[];
  pages: string[];
  defects: MergedDefectReport | null;
};

/** Frozen snapshot roots for citation validation. */
export type PublishSourceRoot = { id: string; path: string };

export function sourcesFromMounts(sourceMounts: ReadonlyMap<string, string>): PublishSourceRoot[] {
  return [...sourceMounts].map(([id, sourcePath]) => ({ id, path: sourcePath }));
}

export async function scorePublishable(input: {
  wikiRoot: string;
  workspaceRoot: string;
  runId: string;
  sources: PublishSourceRoot[];
  spec?: WikiRunSpec | null;
  requireReviewReceipt?: boolean;
}): Promise<PublishabilityResult> {
  const reasons: string[] = [];
  const pages = (await scanWikiTree(input.wikiRoot)).files
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath.toLowerCase().endsWith(".md"));
  if (pages.length === 0) {
    reasons.push("no staged wiki pages");
  }

  const spec = input.spec;
  if (spec?.pages?.length) {
    const pageSet = new Set(pages.map((p) => p.replace(/^\.?\//, "")));
    for (const p of spec.pages) {
      if (p.critical === false) continue;
      const norm = p.path.replace(/^\.?\//, "");
      if (!pageSet.has(norm)) {
        reasons.push(`missing critical page: ${norm}`);
      }
    }
  }

  const validation = await validateWikiTree(input.wikiRoot, {
    sources: input.sources,
  });
  if (!validation.ok) {
    reasons.push(`validation: ${validation.errors.slice(0, 10).join("; ")}`);
  }

  const indexes = await validateWikiIndexes(input.wikiRoot);
  if (!indexes.ok) {
    reasons.push(`indexes: ${indexes.errors.slice(0, 10).join("; ")}`);
  }

  const defects = await readMergedDefects(input.workspaceRoot, input.runId);
  const reviewRequired = spec?.acceptance?.reviewRequired !== false;
  const requireReceipt = input.requireReviewReceipt !== false;

  if (reviewRequired) {
    if (!defects && requireReceipt) {
      reasons.push("review required but defects.json missing");
    } else if (defects) {
      const blocking = (spec?.acceptance?.blockingSeverities ?? ["blocking"]) as DefectSeverity[];
      if (hasBlockingDefects(defects, blocking)) {
        reasons.push(
          `blocking defects remain (${defects.defects.filter((d) => blocking.includes(d.severity)).length})`,
        );
      }
    }
  }

  return {
    publishable: reasons.length === 0,
    reasons,
    pages,
    defects,
  };
}
