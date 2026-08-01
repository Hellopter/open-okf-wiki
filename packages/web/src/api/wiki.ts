/**
 * Published wiki list / graph / page HTTP API.
 */

import { z } from "zod";
import { request } from "./client";

export type WikiPageSummary = {
  path: string;
  type?: string;
  title?: string;
  description?: string;
};

/** Reader TOC node from the list endpoint (index-aware order). */
export type WikiNavNode =
  | { kind: "page"; path: string; title?: string }
  | { kind: "dir"; path: string; title: string; children: WikiNavNode[] }
  | {
      kind: "group";
      title: string;
      children: WikiNavNode[];
      source?: "index" | "unlisted" | "fallback";
    };

export type WikiPageListResponse = {
  workspaceId: string;
  publicationPath: string;
  pages: string[];
  /** Frontmatter metadata per page (concept pages carry type/title/description). */
  summaries?: WikiPageSummary[];
  /** Index-ordered navigation tree (concept pages only). */
  nav?: WikiNavNode[];
};

export type WikiGraphNode = {
  path: string;
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  generatedBy?: string;
  generatedAt?: string;
  trustTier: "unverified" | "machine-confirmed" | "human-reviewed";
};

export type WikiGraphResponse = {
  workspaceId: string;
  nodes: WikiGraphNode[];
  edges: Array<{ from: string; to: string }>;
  brokenLinks: Array<{ from: string; target: string; resolved?: string }>;
};

export type WikiPageResponse = {
  path: string;
  content: string;
  title?: string;
};

const WikiPageSummarySchema = z.object({
  path: z.string(),
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const WikiNavNodeSchema: z.ZodType<WikiNavNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("page"), path: z.string(), title: z.string().optional() }),
    z.object({
      kind: z.literal("dir"),
      path: z.string(),
      title: z.string(),
      children: z.array(WikiNavNodeSchema),
    }),
    z.object({
      kind: z.literal("group"),
      title: z.string(),
      children: z.array(WikiNavNodeSchema),
      source: z.enum(["index", "unlisted", "fallback"]).optional(),
    }),
  ]),
);

const WikiPageListResponseSchema = z.object({
  workspaceId: z.string(),
  publicationPath: z.string(),
  pages: z.array(z.string()),
  summaries: z.array(WikiPageSummarySchema).optional(),
  nav: z.array(WikiNavNodeSchema).optional(),
});
const WikiGraphResponseSchema = z.object({
  workspaceId: z.string(),
  nodes: z.array(
    z.object({
      path: z.string(),
      type: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      generatedBy: z.string().optional(),
      generatedAt: z.string().optional(),
      trustTier: z.enum(["unverified", "machine-confirmed", "human-reviewed"]),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  brokenLinks: z.array(
    z.object({ from: z.string(), target: z.string(), resolved: z.string().optional() }),
  ),
});
const WikiPageResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  title: z.string().optional(),
});

/** List published wiki markdown pages (404 when missing/empty). */
export function listWikiPages(workspaceId: string): Promise<WikiPageListResponse> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/wiki`).then(
    WikiPageListResponseSchema.parse,
  );
}

/** Derived cross-link graph of the Published Wiki (Wiki Visualization data). */
export function getWikiGraph(workspaceId: string): Promise<WikiGraphResponse> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/wiki-graph`).then(
    WikiGraphResponseSchema.parse,
  );
}

/**
 * Read one published wiki page by relative path (e.g. `overview.md`).
 * Uses the `?path=` query form so nested paths stay simple.
 */
export function getWikiPage(workspaceId: string, pagePath: string): Promise<WikiPageResponse> {
  const params = new URLSearchParams();
  params.set("path", pagePath);
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/wiki?${params.toString()}`,
  ).then(WikiPageResponseSchema.parse);
}
