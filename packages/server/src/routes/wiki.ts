import type { IncomingMessage, ServerResponse } from "node:http";
import {
  derivePublishedWikiGraph,
  listPublishedWikiBrowse,
  PublishedWikiError,
  readPublishedWikiPage,
} from "@okf-wiki/core";
import { sendError, sendJson } from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";

export function publishedWikiHttpStatus(code: PublishedWikiError["code"]): number {
  switch (code) {
    case "not_found":
    case "empty":
      return 404;
    case "invalid_path":
    case "symlink":
      return 400;
    case "too_large":
      return 413;
    case "io":
    default:
      return 500;
  }
}

/**
 * List published wiki pages under workspace.publicationPath.
 * GET /api/workspaces/:id/wiki
 *
 * Includes index-aware `nav` for the reader TOC (concept pages only).
 */
export async function handleListWiki(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  try {
    const browse = await listPublishedWikiBrowse(workspace.publicationPath);
    sendJson(res, 200, {
      workspaceId: workspace.id,
      publicationPath: workspace.publicationPath,
      pages: browse.pages,
      summaries: browse.summaries,
      nav: browse.nav,
    });
  } catch (error) {
    if (error instanceof PublishedWikiError) {
      sendError(res, publishedWikiHttpStatus(error.code), error.message, {
        code: error.code,
      });
      return;
    }
    throw error;
  }
}

/**
 * Derived cross-link graph of the Published Wiki (Wiki Visualization data).
 * GET /api/workspaces/:id/wiki-graph
 */
export async function handleWikiGraph(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  try {
    const graph = await derivePublishedWikiGraph(workspace.publicationPath);
    sendJson(res, 200, { workspaceId: workspace.id, ...graph });
  } catch (error) {
    if (error instanceof PublishedWikiError) {
      sendError(res, publishedWikiHttpStatus(error.code), error.message, {
        code: error.code,
      });
      return;
    }
    throw error;
  }
}

/**
 * Read one published wiki markdown page.
 * GET /api/workspaces/:id/wiki/*path
 * GET /api/workspaces/:id/wiki?path=overview.md
 */
export async function handleReadWiki(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  pagePath: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  const trimmed = pagePath.trim();
  if (!trimmed) {
    sendError(res, 400, "path is required");
    return;
  }

  try {
    const page = await readPublishedWikiPage(workspace.publicationPath, trimmed);
    sendJson(res, 200, page);
  } catch (error) {
    if (error instanceof PublishedWikiError) {
      sendError(res, publishedWikiHttpStatus(error.code), error.message, {
        code: error.code,
      });
      return;
    }
    throw error;
  }
}

/**
 * Match /api/workspaces/:id/wiki and /api/workspaces/:id/wiki/**path.
 * Returns null when the path is not a wiki route.
 */
export function matchWikiApiRoute(
  pathname: string,
): { id: string; pagePath: string | null } | null {
  const parts = pathname.split("/").filter(Boolean);
  // api / workspaces / :id / wiki [ / ...page ]
  if (parts.length < 4) {
    return null;
  }
  if (parts[0] !== "api" || parts[1] !== "workspaces" || parts[3] !== "wiki") {
    return null;
  }
  const id = decodeURIComponent(parts[2]!);
  if (parts.length === 4) {
    return { id, pagePath: null };
  }
  const pagePath = parts
    .slice(4)
    .map((p) => decodeURIComponent(p))
    .join("/");
  return { id, pagePath };
}
