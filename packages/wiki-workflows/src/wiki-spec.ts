const DOMAIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PAGE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.md$/;

export type WikiSpecPageType = "overview" | "domain" | "architecture" | "module" | "flow" | "concept" | "state" | "data";

export interface WikiSpecPage {
  pageType: WikiSpecPageType;
  path: string;
  title: string;
  purpose: string;
  readerQuestions: string[];
  requiredFacets: string[];
  findingIds: string[];
}

export interface WikiDomain {
  id: string;
  title: string;
  purpose: string;
  pages: WikiSpecPage[];
}

export interface WikiSpec {
  version: 1;
  overview: WikiSpecPage;
  architecture?: WikiSpecPage;
  domains: WikiDomain[];
  crossLinks: Array<{ fromPath: string; toPath: string; purpose: string }>;
  sharedTerms: Array<{ term: string; definition: string }>;
  omissions: Array<{ findingId: string; rationale: string }>;
}

const CHILD_DIRECTORIES: Readonly<Record<Exclude<WikiSpecPageType, "overview" | "architecture" | "domain">, string>> = {
  concept: "concepts",
  flow: "flows",
  state: "states",
  data: "data",
  module: "modules",
};

export function wikiSpecPages(spec: WikiSpec): WikiSpecPage[] {
  return [spec.overview, ...(spec.architecture ? [spec.architecture] : []), ...spec.domains.flatMap((domain) => domain.pages)];
}

export function wikiSpecPagePaths(spec: WikiSpec): string[] {
  return wikiSpecPages(spec).map((page) => page.path);
}

/** Parse an untrusted persisted or Agent-produced WikiSpec and enforce its complete topology. */
export function parseWikiSpec(value: unknown): WikiSpec {
  const spec = record(value, "WikiSpec");
  exactKeys(spec, "WikiSpec", ["version", "overview", "architecture", "domains", "crossLinks", "sharedTerms", "omissions"]);
  if (spec.version !== 1) throw new Error("WikiSpec must declare version: 1");
  const overview = parsePage(spec.overview, "overview");
  if (overview.pageType !== "overview" || overview.path !== "overview.md") throw new Error("WikiSpec overview must be overview.md with pageType overview");
  const architecture = spec.architecture === undefined ? undefined : parsePage(spec.architecture, "architecture");
  if (architecture && (architecture.pageType !== "architecture" || architecture.path !== "architecture.md")) {
    throw new Error("WikiSpec architecture must be architecture.md with pageType architecture");
  }
  if (!Array.isArray(spec.domains) || spec.domains.length === 0) throw new Error("WikiSpec domains must be a non-empty array");
  const domains = spec.domains.map(parseDomain);
  const result: WikiSpec = {
    version: 1,
    overview,
    ...(architecture ? { architecture } : {}),
    domains,
    crossLinks: array(spec.crossLinks, "WikiSpec crossLinks").map((entry, index) => parseCrossLink(entry, index)),
    sharedTerms: array(spec.sharedTerms, "WikiSpec sharedTerms").map((entry, index) => parsePair(entry, `WikiSpec sharedTerms[${index}]`, "term", "definition")),
    omissions: array(spec.omissions, "WikiSpec omissions").map((entry, index) => parsePair(entry, `WikiSpec omissions[${index}]`, "findingId", "rationale")),
  };
  const domainIds = new Set<string>();
  for (const domain of domains) {
    if (domainIds.has(domain.id)) throw new Error(`WikiSpec domain id is duplicated: ${domain.id}`);
    domainIds.add(domain.id);
  }
  const paths = wikiSpecPagePaths(result);
  if (new Set(paths).size !== paths.length) throw new Error("WikiSpec page paths must be unique");
  const knownPaths = new Set(paths);
  for (const link of result.crossLinks) {
    if (!knownPaths.has(link.fromPath) || !knownPaths.has(link.toPath)) {
      throw new Error(`WikiSpec crossLink must reference declared pages: ${link.fromPath} -> ${link.toPath}`);
    }
  }
  return result;
}

function parseDomain(value: unknown, index: number): WikiDomain {
  const label = `WikiSpec domains[${index}]`;
  const domain = record(value, label);
  exactKeys(domain, label, ["id", "title", "purpose", "pages"]);
  const id = text(domain.id, `${label}.id`);
  if (!DOMAIN_ID.test(id)) throw new Error(`${label}.id must be a safe lowercase top-level slug`);
  if (!Array.isArray(domain.pages)) throw new Error(`${label}.pages must be an array`);
  const pages = domain.pages.map((page, pageIndex) => parsePage(page, `${label}.pages[${pageIndex}]`));
  const expectedDomainPage = `${id}/domain.md`;
  if (pages.filter((page) => page.pageType === "domain" && page.path === expectedDomainPage).length !== 1) {
    throw new Error(`${label} must contain exactly one ${expectedDomainPage} domain page`);
  }
  for (const page of pages) {
    if (page.pageType === "domain") {
      if (page.path !== expectedDomainPage) throw new Error(`${label} domain page must be ${expectedDomainPage}`);
      continue;
    }
    const directory = CHILD_DIRECTORIES[page.pageType as keyof typeof CHILD_DIRECTORIES];
    if (!directory) throw new Error(`${label} cannot contain ${page.pageType} pages`);
    const prefix = `${id}/${directory}/`;
    const basename = page.path.slice(prefix.length);
    if (!page.path.startsWith(prefix) || !PAGE_SLUG.test(basename)) {
      throw new Error(`${label} ${page.pageType} page must match ${prefix}<slug>.md`);
    }
  }
  return { id, title: text(domain.title, `${label}.title`), purpose: text(domain.purpose, `${label}.purpose`), pages };
}

function parsePage(value: unknown, label: string): WikiSpecPage {
  const page = record(value, label);
  exactKeys(page, label, ["pageType", "path", "title", "purpose", "readerQuestions", "requiredFacets", "findingIds"]);
  const pageType = text(page.pageType, `${label}.pageType`);
  if (!["overview", "domain", "architecture", "module", "flow", "concept", "state", "data"].includes(pageType)) {
    throw new Error(`${label}.pageType is invalid`);
  }
  return {
    pageType: pageType as WikiSpecPageType,
    path: text(page.path, `${label}.path`),
    title: text(page.title, `${label}.title`),
    purpose: text(page.purpose, `${label}.purpose`),
    readerQuestions: stringArray(page.readerQuestions, `${label}.readerQuestions`),
    requiredFacets: stringArray(page.requiredFacets, `${label}.requiredFacets`),
    findingIds: stringArray(page.findingIds, `${label}.findingIds`),
  };
}

function parseCrossLink(value: unknown, index: number): { fromPath: string; toPath: string; purpose: string } {
  const label = `WikiSpec crossLinks[${index}]`;
  const link = record(value, label);
  exactKeys(link, label, ["fromPath", "toPath", "purpose"]);
  return { fromPath: text(link.fromPath, `${label}.fromPath`), toPath: text(link.toPath, `${label}.toPath`), purpose: text(link.purpose, `${label}.purpose`) };
}

function parsePair<A extends string, B extends string>(value: unknown, label: string, first: A, second: B): Record<A | B, string> {
  const item = record(value, label);
  exactKeys(item, label, [first, second]);
  return { [first]: text(item[first], `${label}.${first}`), [second]: text(item[second], `${label}.${second}`) } as Record<A | B, string>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => String(item).trim()))];
}

function exactKeys(value: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}
