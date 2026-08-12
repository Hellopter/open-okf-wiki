export interface WikiSpecPage {
  pageType: "overview" | "domain" | "architecture" | "module" | "flow" | "concept" | "state" | "data";
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
  domains: WikiDomain[];
  crossLinks: Array<{ fromPath: string; toPath: string; purpose: string }>;
  sharedTerms: Array<{ term: string; definition: string }>;
  omissions: Array<{ findingId: string; rationale: string }>;
}
