/**
 * Build a directory tree from flat wiki page paths (e.g. modules/foo.md).
 */

export type WikiPageTreeNode = {
  /** Segment name (file or folder). */
  name: string;
  /** Full path for files; folder prefix without trailing slash for dirs. */
  path: string;
  kind: "file" | "dir";
  children?: WikiPageTreeNode[];
};

export function buildWikiPageTree(pages: readonly string[]): WikiPageTreeNode[] {
  type Mutable = {
    name: string;
    path: string;
    kind: "file" | "dir";
    children?: Map<string, Mutable>;
  };

  const root = new Map<string, Mutable>();

  for (const raw of pages) {
    const path = raw.replace(/^\/+/, "").replace(/\\/g, "/");
    if (!path || path.includes("..")) continue;
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let cursor = root;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isFile = i === parts.length - 1;
      prefix = prefix ? `${prefix}/${part}` : part;
      let node = cursor.get(part);
      if (!node) {
        node = {
          name: part,
          path: prefix,
          kind: isFile ? "file" : "dir",
          children: isFile ? undefined : new Map(),
        };
        cursor.set(part, node);
      } else if (!isFile && node.kind === "file") {
        // Prefer directory if both exist (shouldn't).
        node.kind = "dir";
        node.children = node.children ?? new Map();
      }
      if (!isFile) {
        node.children = node.children ?? new Map();
        cursor = node.children;
      }
    }
  }

  function toList(map: Map<string, Mutable>): WikiPageTreeNode[] {
    const nodes = [...map.values()].map((n): WikiPageTreeNode => {
      if (n.kind === "dir" && n.children) {
        return {
          name: n.name,
          path: n.path,
          kind: "dir",
          children: toList(n.children),
        };
      }
      return { name: n.name, path: n.path, kind: "file" };
    });
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  return toList(root);
}

/** Paths of dirs that contain the active page (for auto-expand). */
export function ancestorDirPaths(pagePath: string): string[] {
  const parts = pagePath.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length <= 1) return [];
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(0, i + 1).join("/"));
  }
  return out;
}
