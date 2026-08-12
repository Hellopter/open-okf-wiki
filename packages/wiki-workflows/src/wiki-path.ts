const WIKI_SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_WIKI_PAGE_NAMES = new Set(["index.md", "log.md"]);

/** Markdown files owned by the Wiki lifecycle rather than the concept manifest. */
export function isReservedWikiPagePath(value: unknown): value is string {
  return typeof value === "string" && RESERVED_WIKI_PAGE_NAMES.has(value.split("/").at(-1) ?? "");
}

/**
 * Wiki page paths are POSIX-relative paths made only from ASCII slugs.
 * Keeping this predicate shared prevents model submissions and deterministic
 * finalization from disagreeing about which paths are safe to render in indexes.
 */
export function isSafeWikiPagePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/")) return false;
  const segments = value.split("/");
  if (segments[0] === "wiki" || segments.some((segment) => !segment)) return false;

  const filename = segments.at(-1)!;
  if (!filename.endsWith(".md") || isReservedWikiPagePath(value)) return false;
  const pageSlug = filename.slice(0, -3);
  return WIKI_SLUG_SEGMENT.test(pageSlug)
    && segments.slice(0, -1).every((segment) => WIKI_SLUG_SEGMENT.test(segment));
}
