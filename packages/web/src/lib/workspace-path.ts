/**
 * Workspace-scoped paths (id-only URLs; no rootPath query).
 *
 *   /w/:id              Session and WikiRun workbench
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

/** Operate surface — unified Session and WikiRun workbench (`/w/:id`). */
export function operateHref(workspaceId: string, extraQuery?: Record<string, string>): string {
  return withQuery(`/w/${encodeURIComponent(workspaceId)}`, extraQuery);
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

/**
 * Configure surface (`/w/:id/configure`).
 * Optional hash: sources | general | models (legacy write alias → #general) | skill | danger.
 * Readers still accept #models as general (see ConfigurePage sectionFromHash).
 */
export function configureHref(
  workspaceId: string,
  section?: "sources" | "general" | "models" | "skill" | "danger",
  extraQuery?: Record<string, string>,
): string {
  const base = withQuery(`/w/${encodeURIComponent(workspaceId)}/configure`, extraQuery);
  if (!section) return base;
  // Canonical write target for models/general is #general.
  const hash = section === "models" ? "general" : section;
  return `${base}#${hash}`;
}
