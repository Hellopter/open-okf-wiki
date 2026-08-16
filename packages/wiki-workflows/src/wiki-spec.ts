import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";

const DOMAIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PAGE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.md$/;
const PAGE_TYPES = ["overview", "domain", "architecture", "module", "flow", "concept", "state", "data"] as const;

function nonEmptyString(description: string) {
  return Type.String({ minLength: 1, pattern: "\\S", description });
}

function nonEmptyStringArray(description: string, itemDescription: string) {
  return Type.Array(Type.String({ minLength: 1, description: itemDescription }), { description });
}

const wikiSpecPageTypeSchema = Type.String({
  enum: [...PAGE_TYPES],
  description: "Kind of Wiki page in the published topology.",
});

const wikiSpecPageSchema = Type.Object({
  pageType: wikiSpecPageTypeSchema,
  path: nonEmptyString("Wiki-relative Markdown path for this page."),
  title: nonEmptyString("Human-readable page title."),
  purpose: nonEmptyString("Why this page exists in the Wiki."),
  readerQuestions: nonEmptyStringArray("Questions this page must answer.", "A reader question this page answers."),
  requiredFacets: nonEmptyStringArray("Facets this page must cover.", "A required facet name."),
  findingIds: nonEmptyStringArray("Research findings that ground this page.", "A finding identifier."),
}, { additionalProperties: false, description: "One declared Wiki page." });

const wikiSpecDomainSchema = Type.Object({
  id: nonEmptyString("Lowercase slug for this domain directory."),
  title: nonEmptyString("Human-readable domain title."),
  purpose: nonEmptyString("Why this domain exists in the Wiki."),
  pages: Type.Array(wikiSpecPageSchema, { description: "Domain page and its child pages." }),
}, { additionalProperties: false, description: "One Wiki domain and its pages." });

const wikiSpecCrossLinkSchema = Type.Object({
  fromPath: nonEmptyString("Source page path."),
  toPath: nonEmptyString("Target page path."),
  purpose: nonEmptyString("Why these pages are linked."),
}, { additionalProperties: false, description: "Directed link between declared pages." });

const wikiSpecSharedTermSchema = Type.Object({
  term: nonEmptyString("Shared vocabulary term."),
  definition: nonEmptyString("Meaning of the shared term."),
}, { additionalProperties: false, description: "A term used across domains." });

const wikiSpecOmissionSchema = Type.Object({
  findingId: nonEmptyString("Finding left out of the Wiki."),
  rationale: nonEmptyString("Why this finding is omitted."),
}, { additionalProperties: false, description: "An intentional coverage omission." });

const wikiSpecSchema = Type.Object({
  version: Type.Literal(1, { description: "WikiSpec format version." }),
  overview: wikiSpecPageSchema,
  architecture: Type.Optional(Type.Union([
    wikiSpecPageSchema,
    Type.Null({ description: "Absent architecture page." }),
  ], { description: "Optional architecture page; null is treated as absent." })),
  domains: Type.Array(wikiSpecDomainSchema, { minItems: 1, description: "One or more Wiki domains." }),
  crossLinks: Type.Array(wikiSpecCrossLinkSchema, { description: "Declared links between pages." }),
  sharedTerms: Type.Array(wikiSpecSharedTermSchema, { description: "Shared vocabulary across domains." }),
  omissions: Type.Array(wikiSpecOmissionSchema, { description: "Findings intentionally left unpublished." }),
}, { additionalProperties: false, description: "Complete versioned Wiki topology." });

export const wikiPlanParameters = Type.Object({
  spec: wikiSpecSchema,
}, { additionalProperties: false, description: "wiki_plan tool arguments." });

export type WikiSpecPage = Type.Static<typeof wikiSpecPageSchema>;
type WikiDomain = Type.Static<typeof wikiSpecDomainSchema>;
export type WikiSpec = Omit<Type.Static<typeof wikiSpecSchema>, "architecture"> & {
  architecture?: WikiSpecPage;
};

const wikiSpecValidator = Compile(wikiSpecSchema);

const TYPE_BUCKETS = new Set(["concepts", "flows", "states", "data", "modules"]);
const CLUSTER_FILES: Readonly<Record<string, WikiSpecPage["pageType"]>> = {
  "concept.md": "concept",
  "models.md": "data",
  "flows.md": "flow",
  "sequences.md": "flow",
  "states.md": "state",
  "data.md": "data",
  "modules.md": "module",
};

export type WikiClusterId = string;

export function wikiSpecPages(spec: WikiSpec): WikiSpecPage[] {
  return [spec.overview, ...(spec.architecture ? [spec.architecture] : []), ...spec.domains.flatMap((domain) => domain.pages)];
}

export function wikiSpecPagePaths(spec: WikiSpec): string[] {
  return wikiSpecPages(spec).map((page) => page.path);
}

export function wikiSpecClusterId(pagePath: string): WikiClusterId | undefined {
  const relative = wikiSpecRelativePath(pagePath);
  if (relative === "overview.md" || relative === "architecture.md") return "_root";
  const segments = relative.split("/");
  if (segments.length < 2) return undefined;
  return segments.length === 2 ? segments[0] : `${segments[0]}/${segments[1]}`;
}

export function wikiSpecClusterPaths(spec: WikiSpec, clusterId: WikiClusterId): string[] {
  return wikiSpecPagePaths(spec).filter((pagePath) => wikiSpecClusterId(pagePath) === clusterId);
}

export function wikiSpecClusters(spec: WikiSpec): WikiClusterId[] {
  const clusters = new Set<WikiClusterId>();
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

export function wikiSpecRelativePath(pagePath: string): string {
  return pagePath.startsWith("wiki/") ? pagePath.slice("wiki/".length) : pagePath;
}

/** Parse an untrusted persisted or Agent-produced WikiSpec and enforce its complete topology. */
export function parseWikiSpec(value: unknown): WikiSpec {
  if (!wikiSpecValidator.Check(value)) {
    throw new Error(formatWikiSpecStructureError(wikiSpecValidator.Errors(value)));
  }
  return checkWikiSpecTopology(value);
}

function checkWikiSpecTopology(spec: Type.Static<typeof wikiSpecSchema>): WikiSpec {
  const overview = spec.overview;
  if (overview.pageType !== "overview" || overview.path !== "overview.md") {
    throw new Error("WikiSpec overview must be overview.md with pageType overview");
  }
  const architecture = spec.architecture == null ? undefined : spec.architecture;
  if (architecture && (architecture.pageType !== "architecture" || architecture.path !== "architecture.md")) {
    throw new Error("WikiSpec architecture must be architecture.md with pageType architecture");
  }
  const domains = spec.domains.map(checkDomain);
  const result: WikiSpec = {
    version: 1,
    overview,
    ...(architecture ? { architecture } : {}),
    domains,
    crossLinks: spec.crossLinks,
    sharedTerms: spec.sharedTerms,
    omissions: spec.omissions,
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

function checkDomain(value: WikiDomain, index: number): WikiDomain {
  const label = `WikiSpec domains[${index}]`;
  if (!DOMAIN_ID.test(value.id)) throw new Error(`${label}.id must be a safe lowercase top-level slug`);
  const expectedDomainPage = `${value.id}/domain.md`;
  if (value.pages.filter((page) => page.pageType === "domain" && page.path === expectedDomainPage).length !== 1) {
    throw new Error(`${label} must contain exactly one ${expectedDomainPage} domain page`);
  }
  for (const page of value.pages) {
    if (page.pageType === "domain") {
      if (page.path !== expectedDomainPage) throw new Error(`${label} domain page must be ${expectedDomainPage}`);
      continue;
    }
    if (page.pageType === "overview" || page.pageType === "architecture") {
      throw new Error(`${label} cannot contain ${page.pageType} pages`);
    }
    if (clusterPageType(value.id, page.path) !== page.pageType) {
      throw new Error(`${label} ${page.pageType} page must match ${value.id}/<concept>/<kind>.md`);
    }
  }
  return value;
}

function clusterPageType(domainId: string, pagePath: string): WikiSpecPage["pageType"] | undefined {
  const prefix = `${domainId}/`;
  if (!pagePath.startsWith(prefix)) return undefined;
  const rest = pagePath.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const concept = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (!PAGE_SLUG.test(`${concept}.md`) || TYPE_BUCKETS.has(concept)) return undefined;
  if (CLUSTER_FILES[tail]) return CLUSTER_FILES[tail];
  if (tail.startsWith("models/") && PAGE_SLUG.test(tail.slice("models/".length))) return "data";
  return undefined;
}

function formatWikiSpecStructureError(errors: readonly TLocalizedValidationError[]): string {
  const error = errors[0];
  if (!error) return "WikiSpec is invalid";
  if (error.keyword === "additionalProperties") {
    const extras = Array.isArray(error.params.additionalProperties) ? error.params.additionalProperties : [];
    const field = extras[0] ?? "unknown";
    return `${structurePathLabel(error.instancePath)} has unknown field: ${field}`;
  }
  if (error.keyword === "required") {
    const missing = Array.isArray(error.params.requiredProperties) ? error.params.requiredProperties : [];
    const field = missing[0] ?? "unknown";
    const fieldPath = error.instancePath ? `${error.instancePath}/${field}` : `/${field}`;
    return `WikiSpec ${fieldPath} is required`;
  }
  if (error.keyword === "type" && !error.instancePath) {
    return "WikiSpec must be an object";
  }
  const path = error.instancePath || "/";
  return `WikiSpec ${path} ${error.message}`;
}

function structurePathLabel(instancePath: string): string {
  return instancePath ? `WikiSpec ${instancePath}` : "WikiSpec";
}
