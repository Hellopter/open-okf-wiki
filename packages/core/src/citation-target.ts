/**
 * Citation Target policy — sole path policy for repo: / run-mount multi-source citations.
 *
 * Pure functions only (no filesystem). Callers (canonicalize, rewrite, validate)
 * must not re-implement split / mount-strip / escape rejection.
 *
 * Accepted input forms (path after `repo:`):
 *   - sources/<registeredId>/<repo-relative>   run-mount tool path
 *   - <registeredId>/<repo-relative>           explicit source prefix
 *   - <repo-relative>                          single-source bare path only
 *
 * Skill-form canonical target:
 *   - multi-source:  <sourceId>/<repo-relative>
 *   - single-source: <repo-relative>  (no source-id prefix)
 *
 * Rejects: empty, absolute (`/…`), parent escape (`..`), multi bare without id,
 * empty path after stripping a mount/id prefix. Does not strip a leading
 * `sources/` segment when the next segment is not a registered source id
 * (that path may be a real file under the repository).
 */

/** Options shared by parse / canonicalize. */
export type CitationTargetOptions = {
  /** Registered Snapshot / workspace source ids. */
  sourceIds: readonly string[];
  /** true when more than one source (forces id prefix in canonical form). */
  multiSource: boolean;
};

/**
 * Alias kept for callers that already type against canonicalize options.
 * Same shape as {@link CitationTargetOptions}.
 */
export type CanonicalizeCitationOptions = CitationTargetOptions;

/** Structured citation target after policy parse. */
export type CitationTargetParts = {
  /**
   * Source id when known.
   * - Mount / explicit id prefix: the registered id
   * - Single-source bare path with exactly one registered id: that id
   * - Empty id set + bare path: `""` (anonymous single-source)
   * - Bare path with multiple registered ids and `multiSource: false`: `""`
   *   (path is accepted for canonicalize; structured callers may treat as unbound)
   */
  sourceId: string;
  /** Repository-relative POSIX path within that source (never empty on success). */
  repoPath: string;
};

export type ParseCitationTargetResult =
  | ({ ok: true } & CitationTargetParts)
  | { ok: false; error: string };

export type CanonicalizeCitationResult =
  | { ok: true; target: string }
  | { ok: false; error: string };

/**
 * Normalize + reject absolute / parent-escape / empty raw targets.
 * Returns slash-normalized non-empty segments, or an error.
 */
function normalizeTargetSegments(
  raw: string,
): { ok: true; segments: string[]; display: string } | { ok: false; error: string } {
  const display = raw.trim();
  if (!display) {
    return { ok: false, error: "empty citation path" };
  }
  // Absolute or parent-escape paths are never repository-relative.
  if (display.startsWith("/") || display.includes("..")) {
    return {
      ok: false,
      error: `citation path must be repository-relative POSIX (got ${display})`,
    };
  }
  const normalized = display.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return {
      ok: false,
      error: `citation path must be repository-relative POSIX (got ${display})`,
    };
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { ok: false, error: "empty citation path" };
  }
  return { ok: true, segments, display };
}

/**
 * Parse/split a raw citation target (path after `repo:`) into sourceId + repoPath.
 */
export function parseCitationTarget(
  raw: string,
  options: CitationTargetOptions,
): ParseCitationTargetResult {
  const norm = normalizeTargetSegments(raw);
  if (!norm.ok) {
    return norm;
  }
  const { segments } = norm;
  const ids = new Set(options.sourceIds);

  // Run-mount form: sources/<registeredId>/rest → strip the mount prefix.
  if (segments[0] === "sources" && segments.length >= 2 && ids.has(segments[1]!)) {
    const id = segments[1]!;
    const rest = segments.slice(2).join("/");
    if (!rest) {
      return {
        ok: false,
        error: `empty citation path after stripping sources/${id}/`,
      };
    }
    return { ok: true, sourceId: id, repoPath: rest };
  }

  // Explicit source-id prefix with a non-empty rest.
  if (segments.length >= 2 && ids.has(segments[0]!)) {
    const id = segments[0]!;
    const rest = segments.slice(1).join("/");
    if (!rest) {
      return { ok: false, error: `empty citation path after source id ${id}` };
    }
    return { ok: true, sourceId: id, repoPath: rest };
  }

  // Multi-source requires a registered source-id prefix.
  if (options.multiSource) {
    return {
      ok: false,
      error: `multi-source citation must start with a source id (got ${segments.join("/")})`,
    };
  }

  // Single-source bare path (including real repo paths that start with "sources/"
  // when the next segment is not a registered mount id).
  const repoPath = segments.join("/");
  if (options.sourceIds.length === 1) {
    return { ok: true, sourceId: options.sourceIds[0]!, repoPath };
  }
  // Empty id set, or multiple ids without a matching prefix under single-source mode.
  return { ok: true, sourceId: "", repoPath };
}

/**
 * Format structured parts back to the Skill-form canonical target string.
 * - multi-source with a known id: `<sourceId>/<repoPath>`
 * - otherwise: bare `<repoPath>`
 */
export function formatCitationTarget(
  parts: CitationTargetParts,
  options: Pick<CitationTargetOptions, "multiSource">,
): string {
  if (options.multiSource && parts.sourceId) {
    return `${parts.sourceId}/${parts.repoPath}`;
  }
  return parts.repoPath;
}

/**
 * Canonicalize a citation target to the Skill contract string form.
 * Equivalent to parse → format; rejects the same bad inputs as parse.
 */
export function canonicalizeCitationTarget(
  raw: string,
  options: CitationTargetOptions,
): CanonicalizeCitationResult {
  const parsed = parseCitationTarget(raw, options);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    target: formatCitationTarget(
      { sourceId: parsed.sourceId, repoPath: parsed.repoPath },
      options,
    ),
  };
}

/**
 * Split a citation target into sourceId + repo path (legacy Result shape).
 * Multi-source: requires registered id prefix.
 * Single-source: bare path counts as the sole registered id (when exactly one).
 * Empty registered set: anonymous sourceId `""`.
 * Returns `undefined` on policy failure or when the source id is unbound
 * (multiple registered ids, bare path, single-source mode).
 */
export function parseCitationSourcePath(
  target: string,
  registeredSourceIds: readonly string[],
  multiSource: boolean,
): { sourceId: string; repoPath: string } | undefined {
  const parsed = parseCitationTarget(target, {
    sourceIds: registeredSourceIds,
    multiSource,
  });
  if (!parsed.ok) {
    return undefined;
  }
  // Preserve prior contract: unbound bare path under multiple registered ids
  // is not a successful structured split (canonicalize may still accept it).
  if (parsed.sourceId === "" && registeredSourceIds.length > 0) {
    return undefined;
  }
  return { sourceId: parsed.sourceId, repoPath: parsed.repoPath };
}
