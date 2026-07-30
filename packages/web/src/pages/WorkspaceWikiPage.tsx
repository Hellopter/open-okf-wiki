import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Components } from "streamdown";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import {
  ApiError,
  getWikiGraph,
  getWikiPage,
  getWorkspace,
  listWikiPages,
  type WikiGraphResponse,
  type WikiNavNode,
  type WikiPageResponse,
  type WikiPageSummary,
  type WorkspaceConfig,
} from "../api";
import { LoadingState } from "../components/LoadingState";
import { useI18n } from "../i18n";
import { operateHref, wikiHref } from "../lib/workspace-path";
import { MarkdownDocument } from "../shared/MarkdownDocument";
import { WikiReaderShell } from "../shells/WikiReaderShell";
import { WikiGraphView } from "../wiki/WikiGraphView";
import { WikiPageTree } from "../wiki/WikiPageTree";

/** Strip YAML frontmatter so the body renders without the --- block. */
/**
 * The page header already renders the title — drop a leading `# Title` that
 * duplicates it so the article does not open with the same line twice.
 */
function stripLeadingTitle(markdown: string, title: string | undefined | null): string {
  if (!title) return markdown;
  const match = markdown.match(/^\s*#\s+(.+?)\s*\n+/);
  if (match && match[1]?.trim() === title.trim()) {
    return markdown.slice(match[0].length);
  }
  return markdown;
}

function stripFrontmatter(content: string): string {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return content;
  }
  const firstNl = trimmed.indexOf("\n");
  if (firstNl < 0) {
    return content;
  }
  if (trimmed.slice(0, firstNl).trim() !== "---") {
    return content;
  }
  const rest = trimmed.slice(firstNl + 1);
  const close = rest.search(/^---\s*$/m);
  if (close < 0) {
    return content;
  }
  return rest.slice(close).replace(/^---\s*\n?/, "");
}

/**
 * Resolve a relative markdown href against the current page path.
 * Returns a wiki-relative `.md` path, or null if the link should stay external.
 * Bundle-absolute links (`/overview.md`, OKF §6.1) resolve from the wiki root.
 */
function resolveWikiMdHref(href: string, currentPage: string): string | null {
  if (!href || href.startsWith("#")) {
    return null;
  }
  // Protocol / protocol-relative URL → leave alone
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//")) {
    return null;
  }
  const bundleAbsolute = href.startsWith("/");
  const hashIndex = href.indexOf("#");
  const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  if (!pathPart) {
    return null;
  }
  if (!pathPart.toLowerCase().endsWith(".md")) {
    return null;
  }
  if (pathPart.includes("..")) {
    // Reject escape attempts in content links.
    return null;
  }

  if (bundleAbsolute) {
    const segments = pathPart.split("/").filter((s) => s.length > 0 && s !== ".");
    return segments.length > 0 ? segments.join("/") : null;
  }

  const currentDir = currentPage.includes("/")
    ? currentPage.slice(0, currentPage.lastIndexOf("/"))
    : "";
  const joined = currentDir ? `${currentDir}/${pathPart}` : pathPart;
  const segments = joined.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    return null;
  }
  return segments.join("/");
}

/** First concept page in the nav tree (depth-first). */
function firstNavPage(nodes: readonly WikiNavNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind === "page") return node.path;
    if (node.kind === "dir" || node.kind === "group") {
      const found = firstNavPage(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

function defaultPage(pages: string[], nav?: WikiNavNode[]): string | undefined {
  const fromNav = nav && nav.length > 0 ? firstNavPage(nav) : undefined;
  if (fromNav) return fromNav;
  if (pages.includes("overview.md")) return "overview.md";
  // Skip reserved listings when picking a flat fallback.
  const concept = pages.find((p) => {
    const base = p.split("/").pop()?.toLowerCase() ?? "";
    return base !== "index.md" && base !== "log.md";
  });
  return concept ?? pages[0];
}

/**
 * Parse citation hrefs for chip UI:
 * - Skill form: repo:path#L… (staging / historical)
 * - Publish form: ../sources/<id>/path#L… or /sources/<id>/path#L… (harden may normalize)
 */
function parseSourceCitationHref(href: string): { display: string } | null {
  if (!href) return null;
  if (/^repo:/i.test(href)) {
    return { display: href.replace(/^repo:/i, "") };
  }
  // Portable publish paths (and harden-normalized absolute /sources/…).
  const m = href.match(/(?:^|\/)sources\/([^/#?]+)\/([^?#]*)((?:#L\d+(?:-L\d+)?)?)$/i);
  if (m) {
    const sourceId = m[1]!;
    const rel = m[2] ?? "";
    const frag = m[3] ?? "";
    return { display: `${sourceId}/${rel}${frag}`.replace(/\/+/g, "/").replace(/^\//, "") };
  }
  return null;
}

export function WorkspaceWikiPage() {
  const { t } = useI18n();
  const { id = "", "*": splat = "" } = useParams<{ id: string; "*": string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const graphMode = searchParams.get("view") === "graph";

  const pageFromRoute = useMemo(() => splat.replace(/^\/+/, "").trim(), [splat]);

  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [summaries, setSummaries] = useState<WikiPageSummary[]>([]);
  const [nav, setNav] = useState<WikiNavNode[]>([]);
  const [graph, setGraph] = useState<WikiGraphResponse | null>(null);
  const [page, setPage] = useState<WikiPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [empty, setEmpty] = useState(false);

  const selectPage = useCallback(
    (nextPath: string) => {
      navigate(wikiHref(id, nextPath));
    },
    [id, navigate],
  );

  const setGraphMode = useCallback(
    (next: boolean) => {
      setSearchParams(next ? { view: "graph" } : {}, { replace: true });
    },
    [setSearchParams],
  );

  // Load workspace + page list (id-only; rootPath comes from workspace config).
  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setEmpty(false);
      try {
        const data = await getWorkspace(id);
        if (cancelled) {
          return;
        }
        setWorkspace(data.workspace);
        try {
          const list = await listWikiPages(id);
          if (cancelled) {
            return;
          }
          setPages(list.pages);
          setSummaries(list.summaries ?? []);
          setNav(list.nav ?? []);
          setEmpty(false);
          // Cross-link graph is optional presentation data; failures stay silent.
          getWikiGraph(id)
            .then((data) => {
              if (!cancelled) setGraph(data);
            })
            .catch(() => undefined);
        } catch (listErr) {
          if (cancelled) {
            return;
          }
          if (listErr instanceof ApiError && listErr.status === 404) {
            setPages([]);
            setSummaries([]);
            setNav([]);
            setGraph(null);
            setEmpty(true);
            setPage(null);
          } else {
            throw listErr;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setWorkspace(null);
          setPages([]);
          setSummaries([]);
          setNav([]);
          setGraph(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // When list is ready and no page selected, open default
  useEffect(() => {
    if (loading || empty || pages.length === 0 || graphMode) {
      return;
    }
    if (!pageFromRoute) {
      const fallback = defaultPage(pages, nav);
      if (fallback) {
        selectPage(fallback);
      }
    }
  }, [loading, empty, pages, nav, pageFromRoute, selectPage, graphMode]);

  // Load selected page content
  useEffect(() => {
    if (!id || !workspace || !pageFromRoute || empty) {
      return;
    }
    let cancelled = false;
    (async () => {
      setPageLoading(true);
      setError(null);
      try {
        const data = await getWikiPage(id, pageFromRoute);
        if (!cancelled) {
          setPage(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setPage(null);
        }
      } finally {
        if (!cancelled) {
          setPageLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, workspace, pageFromRoute, empty]);

  const markdownComponents = useMemo<Components>(() => {
    return {
      a({ href, children, ...rest }) {
        if (!href || !pageFromRoute) {
          return (
            <a href={href} {...rest}>
              {children}
            </a>
          );
        }
        // Source Citations — Skill form (repo:) or publish-portable (…/sources/<id>/…).
        const cite = parseSourceCitationHref(href);
        if (
          cite ||
          (typeof children === "string" && children === "Source" && href.includes("sources/"))
        ) {
          const label =
            typeof children === "string" || typeof children === "number"
              ? String(children)
              : "Source";
          const target = cite?.display ?? href.replace(/^repo:/i, "");
          // "a/b/c/spec.md#L13-L29" → "spec.md#L13-L29"; full path in tooltip.
          const [targetPath, targetAnchor] = target.split("#");
          const shortTarget =
            (targetPath?.split("/").filter(Boolean).pop() ?? target) +
            (targetAnchor ? `#${targetAnchor}` : "");
          return (
            <span
              className="wiki-source-cite"
              title={target}
              data-testid="wiki-source-cite"
              data-cite-href={href}
            >
              {label !== "Source" ? <span className="wiki-source-cite__label">{label}</span> : null}
              <span className="wiki-source-cite__target">{shortTarget}</span>
            </span>
          );
        }
        const wikiTarget = resolveWikiMdHref(href, pageFromRoute);
        if (wikiTarget) {
          return (
            <a
              href={wikiHref(id, wikiTarget)}
              {...rest}
              onClick={(event) => {
                event.preventDefault();
                selectPage(wikiTarget);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} {...rest} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    };
  }, [id, pageFromRoute, selectPage]);

  const bodyMarkdown = page ? stripLeadingTitle(stripFrontmatter(page.content), page.title) : "";
  const pageLabel = page?.title ?? (pageFromRoute || undefined);

  const treeTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const summary of summaries) {
      if (summary.title) map[summary.path] = summary.title;
    }
    return map;
  }, [summaries]);

  const pageNode = useMemo(
    () => graph?.nodes.find((node) => node.path === pageFromRoute) ?? null,
    [graph, pageFromRoute],
  );

  const backlinks = useMemo(() => {
    if (!graph || !pageFromRoute) return [];
    return graph.edges
      .filter((edge) => edge.to === pageFromRoute)
      .map((edge) => edge.from)
      .sort((a, b) => a.localeCompare(b));
  }, [graph, pageFromRoute]);

  const trustTierLabel =
    pageNode?.trustTier === "human-reviewed"
      ? t.wiki.trustTier.humanReviewed
      : pageNode?.trustTier === "machine-confirmed"
        ? t.wiki.trustTier.machineConfirmed
        : t.wiki.trustTier.unverified;

  return (
    <WikiReaderShell
      workspaceId={id}
      workspaceName={workspace?.name}
      pageLabel={pageLabel}
      error={error}
      onDismissError={() => setError(null)}
      testId="wiki-page"
    >
      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <LoadingState label={t.wiki.loading} />
        </div>
      ) : empty ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center p-6"
          data-testid="wiki-empty"
        >
          <Empty className="border-0 p-6">
            <EmptyHeader>
              <EmptyTitle className="text-base">{t.wiki.emptyTitle}</EmptyTitle>
              <EmptyDescription>{t.wiki.emptyDescription}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Link
                to={operateHref(id)}
                className={cn(buttonVariants())}
                data-testid="wiki-open-agent"
              >
                {t.wiki.goToAgent}
              </Link>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="wiki-layout">
          <nav
            aria-label={t.wiki.pagesAria}
            className="flex min-h-0 w-full flex-col border-b border-border bg-muted/15 lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r"
          >
            <div className="flex shrink-0 items-center gap-1 px-3 py-2 text-xs font-medium text-muted-foreground">
              <button
                type="button"
                className={cn(
                  "rounded-md px-1.5 py-0.5 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  !graphMode ? "bg-muted text-foreground" : "hover:text-foreground",
                )}
                data-testid="wiki-view-pages"
                aria-pressed={!graphMode}
                onClick={() => setGraphMode(false)}
              >
                {t.wiki.listView}
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-md px-1.5 py-0.5 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  graphMode ? "bg-muted text-foreground" : "hover:text-foreground",
                )}
                data-testid="wiki-view-graph"
                aria-pressed={graphMode}
                onClick={() => setGraphMode(true)}
              >
                {t.wiki.graphView}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
              <WikiPageTree
                pages={pages}
                nav={nav}
                activePath={pageFromRoute}
                titles={treeTitles}
                unlistedLabel={t.wiki.unlisted}
                onSelect={selectPage}
              />
            </div>
          </nav>

          {graphMode && graph ? (
            <WikiGraphView
              graph={graph}
              activePath={pageFromRoute || undefined}
              onSelect={selectPage}
              ariaLabel={t.wiki.graphAria}
              emptyLabel={t.wiki.graphEmpty}
            />
          ) : (
            <div
              className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6 lg:p-8"
              data-testid="wiki-page-content"
            >
              {pageLoading && !page ? (
                <LoadingState label={t.wiki.loadingPage} />
              ) : page ? (
                <article className="mx-auto max-w-3xl">
                  {page.title ? (
                    <h1 className="wiki-page-title" data-testid="wiki-page-title">
                      {page.title}
                    </h1>
                  ) : (
                    <h1 className="wiki-page-title muted">{page.path}</h1>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="wiki-page-path font-mono">{page.path}</span>
                    {pageNode?.type ? (
                      <span
                        className="rounded-full border border-border px-2 py-0.5"
                        data-testid="wiki-page-type"
                      >
                        {pageNode.type}
                      </span>
                    ) : null}
                    {pageNode ? (
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5",
                          pageNode.trustTier === "unverified"
                            ? "border-border"
                            : "border-success/40 text-success",
                        )}
                        data-testid="wiki-page-trust"
                      >
                        {trustTierLabel}
                      </span>
                    ) : null}
                    {pageNode?.generatedAt ? (
                      <span title={pageNode.generatedBy}>
                        {t.wiki.generatedAt} {pageNode.generatedAt.slice(0, 10)}
                      </span>
                    ) : null}
                  </div>
                  <MarkdownDocument
                    key={page.path}
                    content={bodyMarkdown}
                    surface="wiki"
                    mode="static"
                    components={markdownComponents}
                  />
                  {backlinks.length > 0 ? (
                    <footer
                      className="mt-8 border-t border-border pt-3 text-sm"
                      data-testid="wiki-backlinks"
                    >
                      <span className="text-xs font-medium text-muted-foreground">
                        {t.wiki.backlinks}
                      </span>
                      <ul className="mt-1.5 flex flex-wrap gap-2">
                        {backlinks.map((from) => (
                          <li key={from}>
                            <a
                              href={wikiHref(id, from)}
                              className="text-primary hover:underline"
                              data-testid="wiki-backlink"
                              onClick={(event) => {
                                event.preventDefault();
                                selectPage(from);
                              }}
                            >
                              {treeTitles[from] ?? from}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </footer>
                  ) : null}
                </article>
              ) : (
                <p className="muted">{t.wiki.selectPage}</p>
              )}
            </div>
          )}
        </div>
      )}
    </WikiReaderShell>
  );
}
