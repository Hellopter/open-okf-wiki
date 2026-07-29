/**
 * Left-rail hierarchical TOC for Published Wiki.
 *
 * Prefers server-built `nav` (index.md order/groups). Falls back to a path tree
 * from flat page paths when `nav` is absent (older API / empty).
 */

import { ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { WikiNavNode } from "../api";
import { ancestorDirPaths, buildWikiPageTree, type WikiPageTreeNode } from "./page-tree";

export type WikiPageTreeProps = {
  /** Flat page paths (fallback when `nav` is missing). */
  pages: string[];
  /** Index-aware TOC from the list API. */
  nav?: WikiNavNode[];
  activePath: string;
  onSelect: (pagePath: string) => void;
  /** Optional frontmatter titles by page path; falls back to nav title / filename. */
  titles?: Readonly<Record<string, string>>;
  /** Localized label for the Unlisted group. */
  unlistedLabel?: string;
  className?: string;
};

/** Paths of dirs that should auto-expand for the active page (nav-aware). */
function navAncestorDirPaths(nodes: readonly WikiNavNode[], activePath: string): string[] {
  const found: string[] = [];
  const walk = (list: readonly WikiNavNode[], trail: string[]): boolean => {
    for (const node of list) {
      if (node.kind === "page") {
        if (node.path === activePath) {
          found.push(...trail);
          return true;
        }
      } else if (node.kind === "dir") {
        if (walk(node.children, [...trail, node.path])) return true;
      } else {
        if (walk(node.children, trail)) return true;
      }
    }
    return false;
  };
  walk(nodes, []);
  return found;
}

function pathTreeToNav(nodes: WikiPageTreeNode[]): WikiNavNode[] {
  return nodes.map((n): WikiNavNode => {
    if (n.kind === "dir") {
      return {
        kind: "dir",
        path: n.path,
        title: n.name,
        children: pathTreeToNav(n.children ?? []),
      };
    }
    return { kind: "page", path: n.path };
  });
}

function TreeBranch({
  node,
  activePath,
  depth,
  expanded,
  titles,
  unlistedLabel,
  onToggle,
  onSelect,
}: {
  node: WikiNavNode;
  activePath: string;
  depth: number;
  expanded: Set<string>;
  titles?: Readonly<Record<string, string>>;
  unlistedLabel?: string;
  onToggle: (path: string) => void;
  onSelect: (pagePath: string) => void;
}) {
  if (node.kind === "page") {
    const active = node.path === activePath;
    const basename = node.path.includes("/")
      ? node.path.slice(node.path.lastIndexOf("/") + 1)
      : node.path;
    const label = titles?.[node.path] ?? node.title ?? basename;
    return (
      <li>
        <button
          type="button"
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors",
            active
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          )}
          style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
          data-testid="wiki-page-link"
          data-page={node.path}
          aria-current={active ? "page" : undefined}
          title={node.path}
          onClick={() => onSelect(node.path)}
        >
          <FileTextIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </li>
    );
  }

  if (node.kind === "group") {
    const kids = node.children;
    const label = node.source === "unlisted" && unlistedLabel ? unlistedLabel : node.title;
    return (
      <li className="mt-1 first:mt-0" data-testid="wiki-toc-group" data-group={node.title}>
        <div
          className="px-2 py-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground/80"
          style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
        >
          {label}
        </div>
        {kids.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {kids.map((child, i) => (
              <TreeBranch
                key={
                  child.kind === "page"
                    ? child.path
                    : `${child.kind}:${"path" in child ? child.path : child.title}:${i}`
                }
                node={child}
                activePath={activePath}
                depth={depth}
                expanded={expanded}
                titles={titles}
                unlistedLabel={unlistedLabel}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  // dir
  const open = expanded.has(node.path);
  const kids = node.children;

  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
        data-testid="wiki-toc-dir"
        data-dir={node.path}
        aria-expanded={open}
        onClick={() => onToggle(node.path)}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="min-w-0 truncate font-medium">{node.title}</span>
      </button>
      {open && kids.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {kids.map((child, i) => (
            <TreeBranch
              key={
                child.kind === "page"
                  ? child.path
                  : `${child.kind}:${"path" in child ? child.path : child.title}:${i}`
              }
              node={child}
              activePath={activePath}
              depth={depth + 1}
              expanded={expanded}
              titles={titles}
              unlistedLabel={unlistedLabel}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function WikiPageTree({
  pages,
  nav,
  activePath,
  onSelect,
  titles,
  unlistedLabel,
  className,
}: WikiPageTreeProps) {
  const tree = useMemo((): WikiNavNode[] => {
    if (nav && nav.length > 0) return nav;
    // Fallback: path tree, drop reserved basenames from the rail.
    const filtered = pages.filter((p) => {
      const base = p.split("/").pop()?.toLowerCase() ?? "";
      return base !== "index.md" && base !== "log.md";
    });
    return pathTreeToNav(buildWikiPageTree(filtered));
  }, [nav, pages]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Auto-expand ancestors of the active page.
  useEffect(() => {
    if (!activePath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const fromNav = nav && nav.length > 0 ? navAncestorDirPaths(nav, activePath) : [];
      for (const dir of fromNav.length > 0 ? fromNav : ancestorDirPaths(activePath)) {
        next.add(dir);
      }
      return next;
    });
  }, [activePath, nav]);

  const onToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <ul
      className={cn("m-0 flex list-none flex-col gap-0.5 p-0", className)}
      data-testid="wiki-page-list"
    >
      {tree.map((node, i) => (
        <TreeBranch
          key={
            node.kind === "page"
              ? node.path
              : `${node.kind}:${"path" in node ? node.path : node.title}:${i}`
          }
          node={node}
          activePath={activePath}
          depth={0}
          expanded={expanded}
          titles={titles}
          unlistedLabel={unlistedLabel}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
