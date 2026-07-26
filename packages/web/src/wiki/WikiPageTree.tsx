/**
 * Left-rail hierarchical TOC for Published Wiki paths.
 */

import { ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ancestorDirPaths, buildWikiPageTree, type WikiPageTreeNode } from "./page-tree";

export type WikiPageTreeProps = {
  pages: string[];
  activePath: string;
  onSelect: (pagePath: string) => void;
  /** Optional frontmatter titles by page path; falls back to the filename. */
  titles?: Readonly<Record<string, string>>;
  className?: string;
};

function TreeBranch({
  node,
  activePath,
  depth,
  expanded,
  titles,
  onToggle,
  onSelect,
}: {
  node: WikiPageTreeNode;
  activePath: string;
  depth: number;
  expanded: Set<string>;
  titles?: Readonly<Record<string, string>>;
  onToggle: (path: string) => void;
  onSelect: (pagePath: string) => void;
}) {
  if (node.kind === "file") {
    const active = node.path === activePath;
    const label = titles?.[node.path] ?? node.name;
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

  const open = expanded.has(node.path);
  const kids = node.children ?? [];

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
        <span className="min-w-0 truncate font-medium">{node.name}</span>
      </button>
      {open && kids.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {kids.map((child) => (
            <TreeBranch
              key={child.path}
              node={child}
              activePath={activePath}
              depth={depth + 1}
              expanded={expanded}
              titles={titles}
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
  activePath,
  onSelect,
  titles,
  className,
}: WikiPageTreeProps) {
  const tree = useMemo(() => buildWikiPageTree(pages), [pages]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Auto-expand ancestors of the active page.
  useEffect(() => {
    if (!activePath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of ancestorDirPaths(activePath)) next.add(dir);
      return next;
    });
  }, [activePath]);

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
      {tree.map((node) => (
        <TreeBranch
          key={node.path}
          node={node}
          activePath={activePath}
          depth={0}
          expanded={expanded}
          titles={titles}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
