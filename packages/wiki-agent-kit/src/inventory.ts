import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathIgnored } from "./ignores.js";

export interface InventoryUnit { id: string; kind: "source" | "surface"; sourceId: string; path: string; required: true; label: string }
export interface Inventory { version: 1; generatedAt: string; wikiLanguage: string; tier: "L0" | "L1" | "L2" | "L3"; sourceCount: number; fileCount: number; sources: unknown[]; coverageUnits: InventoryUnit[] }

async function filesIn(root: string, patterns: string[], maximum = 50_000): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string, relative = ""): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (pathIgnored(childRelative, patterns) || pathIgnored(`${childRelative}/`, patterns)) continue;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), childRelative);
      else if (entry.isFile()) {
        if (output.length >= maximum) throw new Error(`inventory file limit exceeded (${maximum}) for ${root}; add ignore rules`);
        output.push(childRelative);
      }
    }
  };
  await visit(root);
  return output.sort();
}

function buildKind(files: string[]): string {
  if (files.includes("pom.xml")) return "maven";
  if (files.some((file) => path.posix.basename(file).startsWith("build.gradle"))) return "gradle";
  if (files.includes("package.json")) return "node";
  if (files.includes("pyproject.toml") || files.includes("setup.py")) return "python";
  if (files.includes("Cargo.toml")) return "rust";
  if (files.includes("go.mod")) return "go";
  return "unknown";
}

function surfaces(files: string[]): string[] {
  const directories = files
    .filter((file) => file === "package.json" || /^(packages|apps|services)\/[^/]+\/package\.json$/.test(file))
    .map((file) => path.posix.dirname(file));
  return [...new Set(directories)].filter((directory) => directory !== ".");
}

export async function buildInventory(sources: Array<{ id: string; root: string; patterns: string[] }>, wikiLanguage: string, now: string): Promise<Inventory> {
  const sourceRecords: unknown[] = [];
  const coverageUnits: InventoryUnit[] = [];
  let fileCount = 0;
  for (const source of sources) {
    const files = await filesIn(source.root, source.patterns);
    const sourceSurfaces = surfaces(files);
    fileCount += files.length;
    sourceRecords.push({ sourceId: source.id, build: buildKind(files), fileCount: files.length, surfaces: sourceSurfaces.map((value) => ({ path: value, kind: "package" })), effectiveIgnores: source.patterns });
    coverageUnits.push({ id: source.id, kind: "source", sourceId: source.id, path: ".", required: true, label: source.id });
    for (const surface of sourceSurfaces) coverageUnits.push({ id: `${source.id}::${surface}`, kind: "surface", sourceId: source.id, path: surface, required: true, label: `${source.id}::${surface}` });
  }
  const surfaceCount = coverageUnits.filter((unit) => unit.kind === "surface").length;
  const tier = sources.length >= 2 ? "L3" : fileCount > 2_000 || surfaceCount > 4 ? "L2" : fileCount > 200 || surfaceCount > 1 ? "L1" : "L0";
  return { version: 1, generatedAt: now, wikiLanguage, tier, sourceCount: sources.length, fileCount, sources: sourceRecords, coverageUnits };
}
