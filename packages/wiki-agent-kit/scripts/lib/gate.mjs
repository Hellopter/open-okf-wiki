/**
 * Plan gates: assertCoverage + assertSemanticSufficiency (fail-closed).
 */

import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function assertCoverage({ inventory, spec, discoveryMap }) {
  const errors = [];
  const warnings = [];
  const units = inventory?.coverageUnits ?? discoveryMap?.coverageUnits ?? [];
  const required = units.filter((u) => u.required !== false);
  if (required.length === 0) {
    warnings.push("no coverage units in inventory");
    return { ok: true, errors, warnings };
  }
  if (!spec) {
    errors.push("missing spec.json — cannot assert coverage");
    return { ok: false, errors, warnings };
  }

  const bound = new Set();
  const cancelled = new Set();

  for (const page of spec.pages ?? []) {
    for (const id of page.coverageUnitIds ?? []) bound.add(id);
    for (const id of page.sourceIds ?? []) bound.add(id);
    for (const id of page.surfaceIds ?? []) bound.add(id);
  }
  for (const d of spec.domains ?? []) {
    for (const id of d.coverageUnitIds ?? []) bound.add(id);
  }
  for (const c of spec.sourceCoverage ?? []) {
    if (c.cancelled) {
      if (typeof c.notes !== "string" || !c.notes.trim()) {
        errors.push(
          `cancelled sourceCoverage requires non-empty notes: ${c.sourceId ?? "?"}`,
        );
        continue;
      }
      cancelled.add(c.sourceId);
    }
  }
  for (const c of spec.surfaceCoverage ?? []) {
    if (c.cancelled) {
      if (typeof c.notes !== "string" || !c.notes.trim()) {
        errors.push(
          `cancelled surfaceCoverage requires non-empty notes: ${c.surfaceId ?? "?"}`,
        );
        continue;
      }
      cancelled.add(c.surfaceId);
    }
  }

  for (const u of required) {
    if (bound.has(u.id) || cancelled.has(u.id)) continue;
    // also allow binding by sourceId alone for source units
    if (u.kind === "source" && (bound.has(u.sourceId) || cancelled.has(u.sourceId))) continue;
    errors.push(`coverage unit not bound or cancelled: ${u.id}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function assertSemanticSufficiency({ inventory, spec, discoveryMap }) {
  const errors = [];
  const warnings = [];
  const tier = inventory?.tier ?? "L0";
  const sourceCount = inventory?.sourceCount ?? discoveryMap?.sources?.length ?? 0;

  if (!discoveryMap) {
    if (tier === "L0") {
      warnings.push("no discovery-map (L0 soft)");
      return { ok: true, errors, warnings };
    }
    errors.push("missing discovery-map.json for tier " + tier);
    return { ok: false, errors, warnings };
  }

  const domains = discoveryMap.domains ?? [];
  const flows = discoveryMap.flows ?? [];

  if (tier !== "L0" && domains.length === 0) {
    errors.push("discovery-map has zero domains (semantic insufficiency)");
  }

  if (sourceCount >= 2) {
    const cross = flows.some((f) => f.crossSource === true || f.id === "flow:cross");
    const cancelledCross = (spec?.openQuestions ?? []).some((q) =>
      String(q).toLowerCase().includes("cross"),
    );
    // allow explicit cancel note on spec
    const cancelNote = (spec?.sourceCoverage ?? []).every((c) => c.cancelled);
    if (!cross && !cancelledCross && !cancelNote) {
      // soft-hard: require cross flow candidate or at least multi-source domain
      const multiDomain = domains.some((d) => (d.coverageUnitIds ?? []).length > 1);
      if (!multiDomain) {
        errors.push("multi-source run lacks cross-source flow or multi-unit domain");
      } else {
        warnings.push("multi-source: no explicit crossSource flow; multi-unit domain present");
      }
    }
  }

  if (spec) {
    const pages = spec.pages ?? [];
    if (pages.length === 0) {
      errors.push("spec has zero pages");
    }
    const criticalDomains = (spec.domains ?? []).filter((d) => d.critical !== false);
    for (const d of criticalDomains) {
      const hit = pages.some(
        (p) =>
          (p.domainIds ?? []).includes(d.id) ||
          (p.coverageUnitIds ?? []).some((id) => (d.coverageUnitIds ?? []).includes(id)) ||
          String(p.path).includes(d.id),
      );
      if (!hit && pages.length > 0) {
        // map discovery domain titles to pages by purpose text — soft if no id link
        const byTitle = pages.some(
          (p) =>
            String(p.purpose || "")
              .toLowerCase()
              .includes(String(d.title || d.id).toLowerCase().slice(0, 12)),
        );
        if (!byTitle) {
          warnings.push(`critical domain may lack a page: ${d.id || d.title}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Prefer analysis/discovery-map.json (filled map lives here) over the inputs shell.
 * When both exist, prefer analysis if it has domains; else prefer whichever has domains;
 * otherwise analysis if present, then inputs.
 */
export function loadDiscoveryMap(workdir) {
  const analysis = readJson(path.join(workdir, "analysis", "discovery-map.json"));
  const inputs = readJson(path.join(workdir, "inputs", "discovery-map.json"));
  const analysisDomains = analysis?.domains?.length ?? 0;
  const inputsDomains = inputs?.domains?.length ?? 0;
  if (analysis && analysisDomains > 0) return analysis;
  if (inputs && inputsDomains > 0) return inputs;
  if (analysis) return analysis;
  return inputs;
}

/**
 * Run both gates against a freeze workdir.
 */
export function gatePlan(workdir) {
  const inventory = readJson(path.join(workdir, "inputs", "inventory.json"));
  const discoveryMap = loadDiscoveryMap(workdir);
  const spec =
    readJson(path.join(workdir, "analysis", "spec.json")) ||
    readJson(path.join(workdir, "inputs", "spec.json"));

  const coverage = assertCoverage({ inventory, spec, discoveryMap });
  const semantic = assertSemanticSufficiency({ inventory, spec, discoveryMap });
  const errors = [...coverage.errors, ...semantic.errors];
  const warnings = [...coverage.warnings, ...semantic.warnings];
  return {
    ok: coverage.ok && semantic.ok,
    coverage,
    semantic,
    errors,
    warnings,
  };
}
