/**
 * Workspace-scoped paths (id-only URLs; no rootPath query).
 *
 *   /w/:id/runs         Run Workspace
 *   /w/:id/wiki[/*]     Wiki reader
 *   /w/:id/configure    Configure (sources · models · skill · danger)
 */

function withQuery(base: string, extraQuery?: Record<string, string>): string {
  if (!extraQuery) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(extraQuery)) {
    if (v !== undefined && v !== "") {
      params.set(k, v);
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Operate surface — Run Workspace (`/w/:id/runs`). */
export function operateHref(workspaceId: string, extraQuery?: Record<string, string>): string {
  return withQuery(`/w/${encodeURIComponent(workspaceId)}/runs`, extraQuery);
}

/** Wiki reader (`/w/:id/wiki` or `/w/:id/wiki/{page…}`). */
export function wikiHref(
  workspaceId: string,
  pagePath?: string | null,
  extraQuery?: Record<string, string>,
): string {
  const base = `/w/${encodeURIComponent(workspaceId)}/wiki`;
  if (!pagePath) {
    return withQuery(base, extraQuery);
  }
  const segments = pagePath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return withQuery(`${base}/${segments}`, extraQuery);
}

/** Configure surface (`/w/:id/configure`). Optional hash: sources|models|skill|danger */
export function configureHref(
  workspaceId: string,
  section?: "sources" | "models" | "skill" | "danger",
  extraQuery?: Record<string, string>,
): string {
  const base = withQuery(`/w/${encodeURIComponent(workspaceId)}/configure`, extraQuery);
  return section ? `${base}#${section}` : base;
}
