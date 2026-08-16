import { Type } from "typebox";

const DOMAIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PAGE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.md$/;
const TYPE_BUCKETS = new Set(["concepts", "flows", "states", "data", "modules"]);
const CLUSTER_FILES: Readonly<Record<string, WikiSpecPageType>> = {
  "concept.md": "concept",
  "models.md": "data",
  "flows.md": "flow",
  "sequences.md": "flow",
  "states.md": "state",
  "data.md": "data",
  "modules.md": "module",
};

export type WikiSpecPageType = "overview" | "domain" | "architecture" | "module" | "flow" | "concept" | "state" | "data";
export type WikiSpecPage = { path: string; pageType: WikiSpecPageType };
/** Wiki-relative paths, no wiki/ prefix; unique; input order preserved. */
export type WikiSpec = { pages: string[] };

export const wikiPlanParameters = Type.Object({
  pages: Type.Array(Type.String(), { minItems: 2 }),
}, { additionalProperties: false });

export function wikiSpecRelativePath(pagePath: string): string {
  return pagePath.startsWith("wiki/") ? pagePath.slice("wiki/".length) : pagePath;
}

export function wikiSpecPageType(path: string): WikiSpecPageType | undefined {
  const relative = wikiSpecRelativePath(path);
  if (relative === "overview.md") return "overview";
  if (relative === "architecture.md") return "architecture";
  const segments = relative.split("/");
  if (segments.length === 2 && segments[1] === "domain.md" && DOMAIN_ID.test(segments[0])) return "domain";
  if (segments.length < 3) return undefined;
  const [domain, concept] = segments;
  const tail = segments.slice(2).join("/");
  if (!DOMAIN_ID.test(domain) || !PAGE_SLUG.test(`${concept}.md`) || TYPE_BUCKETS.has(concept)) return undefined;
  if (CLUSTER_FILES[tail]) return CLUSTER_FILES[tail];
  if (tail.startsWith("models/") && PAGE_SLUG.test(tail.slice("models/".length))) return "data";
  return undefined;
}

export function wikiSpecPages(spec: WikiSpec): WikiSpecPage[] {
  return spec.pages.map((path) => ({ path, pageType: wikiSpecPageType(path)! }));
}

export function wikiSpecPagePaths(spec: WikiSpec): string[] {
  return spec.pages;
}

export function wikiSpecDomainIds(spec: WikiSpec): string[] {
  const ids: string[] = [];
  for (const path of spec.pages) {
    const relative = wikiSpecRelativePath(path);
    const slash = relative.indexOf("/");
    if (slash > 0 && relative.slice(slash + 1) === "domain.md" && DOMAIN_ID.test(relative.slice(0, slash))) {
      ids.push(relative.slice(0, slash));
    }
  }
  return ids;
}

export function wikiSpecClusterId(pagePath: string): string | undefined {
  const relative = wikiSpecRelativePath(pagePath);
  if (relative === "overview.md" || relative === "architecture.md") return "_root";
  const segments = relative.split("/");
  if (segments.length < 2) return undefined;
  return segments.length === 2 ? segments[0] : `${segments[0]}/${segments[1]}`;
}

export function wikiSpecClusterPaths(spec: WikiSpec, clusterId: string): string[] {
  return wikiSpecPagePaths(spec).filter((pagePath) => wikiSpecClusterId(pagePath) === clusterId);
}

export function wikiSpecClusters(spec: WikiSpec): string[] {
  const clusters = new Set<string>();
  for (const pagePath of wikiSpecPagePaths(spec)) {
    const clusterId = wikiSpecClusterId(pagePath);
    if (clusterId) clusters.add(clusterId);
  }
  return [...clusters].sort();
}

export function sameWikiCluster(paths: readonly string[]): boolean {
  if (!paths.length) return false;
  const clusterId = wikiSpecClusterId(paths[0]);
  if (!clusterId) return false;
  return paths.every((pagePath) => wikiSpecClusterId(pagePath) === clusterId);
}

/** Parse an untrusted persisted or Agent-produced WikiSpec and enforce its complete topology. */
export function parseWikiSpec(value: unknown): WikiSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WikiSpec must be an object");
  }
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter((key) => key !== "pages");
  if (extras.length) throw new Error(`WikiSpec has unknown field: ${extras[0]}`);
  if (!("pages" in record)) throw new Error("WikiSpec pages is required");
  const pages = record.pages;
  if (!Array.isArray(pages) || pages.some((page) => typeof page !== "string")) {
    throw new Error("WikiSpec pages must be an array of strings");
  }
  if (new Set(pages).size !== pages.length) throw new Error("WikiSpec page paths must be unique");
  for (const path of pages) {
    if (path !== wikiSpecRelativePath(path) || !wikiSpecPageType(path)) {
      throw new Error(`WikiSpec page is not a legal cluster path: ${path}`);
    }
  }
  if (!pages.includes("overview.md")) throw new Error("WikiSpec must include overview.md");
  const domainIds = new Set<string>();
  const prefixes = new Set<string>();
  for (const path of pages) {
    const segments = path.split("/");
    if (segments.length < 2) continue;
    prefixes.add(segments[0]);
    if (segments.length === 2 && segments[1] === "domain.md") domainIds.add(segments[0]);
  }
  if (!domainIds.size) throw new Error("WikiSpec must include at least one domain.md");
  for (const domainId of prefixes) {
    if (!domainIds.has(domainId)) throw new Error(`WikiSpec domain ${domainId} must include exactly one domain.md`);
  }
  return { pages: [...pages] };
}
