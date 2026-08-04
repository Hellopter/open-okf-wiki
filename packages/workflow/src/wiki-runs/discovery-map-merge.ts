/**
 * Pure mechanical merge of plan.scout receipt JSON → contract DiscoveryMap.
 *
 * Used by plan.discover.reduce (pre-plan stage only). No agent synthesis.
 * Host owns topology; this module only reads sealed receipt bodies and merges.
 *
 * Accepts:
 * - Full/partial DiscoveryMap-shaped fragments (sources/domains/flows/…)
 * - Lightweight PlanScoutReceiptJson (kind, sourceId, summary, openQuestions, paths)
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type DiscoveryConceptRow,
  type DiscoveryDomainRow,
  type DiscoveryFlowRow,
  type DiscoveryMap,
  type DiscoveryModuleRow,
  type DiscoverySourceRow,
  DiscoveryMapSchema,
  DiscoverySourceRowSchema,
  DiscoveryDomainRowSchema,
  DiscoveryFlowRowSchema,
  DiscoveryConceptRowSchema,
  DiscoveryModuleRowSchema,
  parseDiscoveryMap,
} from "@okf-wiki/contract/wiki-runs";

/** Canonical filename for sealed discovery map artifacts. */
export const DISCOVERY_MAP_FILE = "discovery-map.json" as const;

/** Mutable builder used while merging scout receipts. */
type DiscoveryMapBuilder = {
  sources: Map<string, DiscoverySourceRow>;
  domains: Map<string, DiscoveryDomainRow>;
  flows: Map<string, DiscoveryFlowRow>;
  concepts: Map<string, DiscoveryConceptRow>;
  modules: Map<string, DiscoveryModuleRow>;
  openQuestions: string[];
  boundaryPaths: string[];
  scoutKinds: string[];
};

function emptyBuilder(): DiscoveryMapBuilder {
  return {
    sources: new Map(),
    domains: new Map(),
    flows: new Map(),
    concepts: new Map(),
    modules: new Map(),
    openQuestions: [],
    boundaryPaths: [],
    scoutKinds: [],
  };
}

function pushUnique(list: string[], value: string, max: number): void {
  const v = value.trim();
  if (!v || list.includes(v) || list.length >= max) return;
  list.push(v.slice(0, 500));
}

function mergeStringLists(into: string[], from: readonly string[] | undefined, max: number): void {
  if (!from) return;
  for (const item of from) pushUnique(into, item, max);
}

function mergeSourceRow(into: DiscoverySourceRow, from: DiscoverySourceRow): DiscoverySourceRow {
  const entryPoints = [...into.entryPoints];
  const surfaces = [...into.surfaces];
  const evidencePaths = [...into.evidencePaths];
  mergeStringLists(entryPoints, from.entryPoints, 32);
  mergeStringLists(surfaces, from.surfaces, 64);
  mergeStringLists(evidencePaths, from.evidencePaths, 64);
  return DiscoverySourceRowSchema.parse({
    sourceId: into.sourceId,
    ...(from.role?.trim() || into.role?.trim()
      ? { role: (from.role?.trim() || into.role || "").slice(0, 500) }
      : {}),
    entryPoints,
    surfaces,
    purpose: (from.purpose?.trim() || into.purpose || "").slice(0, 2_000),
    evidencePaths,
  });
}

function absorbDiscoveryMap(builder: DiscoveryMapBuilder, map: DiscoveryMap): void {
  for (const row of map.sources) {
    const sid = row.sourceId.trim();
    if (!sid) continue;
    const existing = builder.sources.get(sid);
    builder.sources.set(sid, existing ? mergeSourceRow(existing, row) : row);
  }
  for (const row of map.domains) {
    if (!builder.domains.has(row.id)) builder.domains.set(row.id, row);
  }
  for (const row of map.flows) {
    if (!builder.flows.has(row.id)) builder.flows.set(row.id, row);
  }
  for (const row of map.concepts) {
    if (!builder.concepts.has(row.id)) builder.concepts.set(row.id, row);
  }
  for (const row of map.modules ?? []) {
    if (!builder.modules.has(row.id)) builder.modules.set(row.id, row);
  }
  mergeStringLists(builder.openQuestions, map.openQuestions, 64);
  mergeStringLists(builder.boundaryPaths, map.boundaryPaths, 256);
  mergeStringLists(builder.scoutKinds, map.scoutKinds, 64);
}

/**
 * Absorb one scout receipt body into the builder.
 * Returns an error string when the body is unusable; soft-skips empty optional fields.
 */
export function absorbScoutReceipt(
  builder: DiscoveryMapBuilder,
  raw: unknown,
  opts?: { nodeKey?: string; fileName?: string },
): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "scout receipt must be a JSON object";
  }
  const body = raw as Record<string, unknown>;

  // Prefer full/partial DiscoveryMap fragment when recognizable.
  const asMap = parseDiscoveryMap(raw);
  if (asMap) {
    absorbDiscoveryMap(builder, asMap);
  }

  // Lightweight PlanScoutReceiptJson fields (always merge when present).
  const kindGuess =
    (typeof body.kind === "string" && body.kind.trim()) ||
    opts?.fileName?.replace(/\.json$/i, "").replace(/^plan\.scout\./, "").trim() ||
    (opts?.nodeKey?.startsWith("plan.scout.")
      ? opts.nodeKey.slice("plan.scout.".length)
      : undefined);

  if (kindGuess) {
    pushUnique(builder.scoutKinds, kindGuess, 64);
  }

  if (Array.isArray(body.openQuestions)) {
    for (const q of body.openQuestions) {
      if (typeof q === "string") pushUnique(builder.openQuestions, q, 64);
    }
  }

  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];
  const evidencePaths = Array.isArray(body.evidencePaths)
    ? body.evidencePaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : paths;

  const sourceId =
    typeof body.sourceId === "string" && body.sourceId.trim()
      ? body.sourceId.trim()
      : undefined;

  // Source/surface receipts → DiscoverySourceRow with evidence when available.
  if (sourceId && (kindGuess === "source" || kindGuess === "surface" || body.sourceId)) {
    const existing = builder.sources.get(sourceId);
    const surfacePath =
      typeof body.surfacePath === "string" && body.surfacePath.trim()
        ? body.surfacePath.trim()
        : undefined;
    const purpose =
      typeof body.summary === "string" && body.summary.trim()
        ? body.summary.trim().slice(0, 2_000)
        : "";
    const next = DiscoverySourceRowSchema.parse({
      sourceId,
      entryPoints: existing?.entryPoints ?? [],
      surfaces: [
        ...(existing?.surfaces ?? []),
        ...(surfacePath && surfacePath !== "." ? [surfacePath] : []),
      ].slice(0, 64),
      purpose: purpose || existing?.purpose || "",
      evidencePaths: [
        ...(existing?.evidencePaths ?? []),
        ...evidencePaths.map((p) => p.trim().slice(0, 300)),
      ].slice(0, 64),
      ...(existing?.role ? { role: existing.role } : {}),
    });
    // Dedupe surfaces / evidence
    next.surfaces = [...new Set(next.surfaces)];
    next.evidencePaths = [...new Set(next.evidencePaths)];
    builder.sources.set(sourceId, next);
  }

  // Nested partial rows when present on lightweight receipts.
  if (Array.isArray(body.sources) && !asMap) {
    for (const row of body.sources) {
      const parsed = DiscoverySourceRowSchema.safeParse(row);
      if (!parsed.success) continue;
      const existing = builder.sources.get(parsed.data.sourceId);
      builder.sources.set(
        parsed.data.sourceId,
        existing ? mergeSourceRow(existing, parsed.data) : parsed.data,
      );
    }
  }
  if (Array.isArray(body.domains) && !asMap) {
    for (const row of body.domains) {
      const parsed = DiscoveryDomainRowSchema.safeParse(row);
      if (parsed.success && !builder.domains.has(parsed.data.id)) {
        builder.domains.set(parsed.data.id, parsed.data);
      }
    }
  }
  if (Array.isArray(body.flows) && !asMap) {
    for (const row of body.flows) {
      const parsed = DiscoveryFlowRowSchema.safeParse(row);
      if (parsed.success && !builder.flows.has(parsed.data.id)) {
        builder.flows.set(parsed.data.id, parsed.data);
      }
    }
  }
  if (Array.isArray(body.concepts) && !asMap) {
    for (const row of body.concepts) {
      const parsed = DiscoveryConceptRowSchema.safeParse(row);
      if (parsed.success && !builder.concepts.has(parsed.data.id)) {
        builder.concepts.set(parsed.data.id, parsed.data);
      }
    }
  }
  if (Array.isArray(body.modules) && !asMap) {
    for (const row of body.modules) {
      const parsed = DiscoveryModuleRowSchema.safeParse(row);
      if (parsed.success && !builder.modules.has(parsed.data.id)) {
        builder.modules.set(parsed.data.id, parsed.data);
      }
    }
  }

  // Boundary paths from receipt.
  if (Array.isArray(body.boundaryPaths)) {
    for (const p of body.boundaryPaths) {
      if (typeof p === "string") pushUnique(builder.boundaryPaths, p, 256);
    }
  }
  for (const p of paths) {
    // Non-source thematic paths become boundary hints when no sourceId.
    if (!sourceId) pushUnique(builder.boundaryPaths, p, 256);
  }

  return undefined;
}

/** Finalize builder into a sealed DiscoveryMap. */
export function finalizeDiscoveryMap(builder: DiscoveryMapBuilder): DiscoveryMap {
  const modules = [...builder.modules.values()].sort((a, b) => a.id.localeCompare(b.id));
  return DiscoveryMapSchema.parse({
    version: 1,
    sources: [...builder.sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    domains: [...builder.domains.values()].sort((a, b) => a.id.localeCompare(b.id)),
    flows: [...builder.flows.values()].sort((a, b) => a.id.localeCompare(b.id)),
    concepts: [...builder.concepts.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ...(modules.length > 0 ? { modules } : {}),
    openQuestions: builder.openQuestions.slice(0, 64),
    boundaryPaths: builder.boundaryPaths.slice(0, 256),
    scoutKinds: builder.scoutKinds.slice(0, 64).sort((a, b) => a.localeCompare(b)),
  });
}

/** Merge an array of raw scout receipt bodies into one DiscoveryMap. */
export function mergeScoutReceiptsToDiscoveryMap(
  receipts: readonly { raw: unknown; nodeKey?: string; fileName?: string }[],
): { map: DiscoveryMap; errors: string[] } {
  const builder = emptyBuilder();
  const errors: string[] = [];
  for (const item of receipts) {
    const err = absorbScoutReceipt(builder, item.raw, {
      nodeKey: item.nodeKey,
      fileName: item.fileName,
    });
    if (err) {
      errors.push(
        `${item.nodeKey ?? item.fileName ?? "receipt"}: ${err}`,
      );
    }
  }
  return { map: finalizeDiscoveryMap(builder), errors };
}

/**
 * Read scout receipt JSON files from one or more roots (analysis/plan-scouts,
 * artifact prep dirs, or absolute file paths).
 */
export function readScoutReceiptsFromRoots(
  roots: readonly string[],
): { receipts: Array<{ raw: unknown; nodeKey?: string; fileName: string }>; errors: string[] } {
  const receipts: Array<{ raw: unknown; nodeKey?: string; fileName: string }> = [];
  const errors: string[] = [];
  const seenFiles = new Set<string>();

  for (const root of roots) {
    if (!root) continue;
    let files: string[] = [];
    try {
      const st = statSync(root);
      if (st.isFile()) {
        files = [root];
      } else if (st.isDirectory()) {
        const candidates = [
          path.join(root, "plan-scouts"),
          path.join(root, "analysis", "plan-scouts"),
          root,
        ];
        for (const dir of candidates) {
          try {
            const dirSt = statSync(dir);
            if (!dirSt.isDirectory()) continue;
            for (const name of readdirSync(dir)) {
              if (!/\.json$/i.test(name)) continue;
              if (name === DISCOVERY_MAP_FILE) continue;
              files.push(path.join(dir, name));
            }
            if (files.length > 0) break;
          } catch {
            // try next
          }
        }
      }
    } catch {
      errors.push(`unreadable scout receipt root: ${root}`);
      continue;
    }

    for (const file of files) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      const base = path.basename(file);
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
        const nodeKey = base.startsWith("plan.scout.")
          ? base.replace(/\.json$/i, "")
          : `plan.scout.${base.replace(/\.json$/i, "")}`;
        receipts.push({ raw, nodeKey, fileName: base });
      } catch (err) {
        errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { receipts, errors };
}

/**
 * Merge scout receipt files from roots into a DiscoveryMap and optionally write
 * discovery-map.json under `outDir`.
 */
export function mergeDiscoveryMapFromRoots(input: {
  roots: readonly string[];
  /** When set, write DISCOVERY_MAP_FILE under this directory. */
  outDir?: string;
}): { map: DiscoveryMap; errors: string[]; outPath?: string } {
  const { receipts, errors: readErrors } = readScoutReceiptsFromRoots(input.roots);
  const { map, errors: mergeErrors } = mergeScoutReceiptsToDiscoveryMap(receipts);
  const errors = [...readErrors, ...mergeErrors];
  let outPath: string | undefined;
  if (input.outDir) {
    mkdirSync(input.outDir, { recursive: true });
    outPath = path.join(input.outDir, DISCOVERY_MAP_FILE);
    writeFileSync(outPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  }
  return { map, errors, ...(outPath ? { outPath } : {}) };
}
