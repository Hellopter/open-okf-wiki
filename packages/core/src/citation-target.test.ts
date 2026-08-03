/**
 * Citation Target policy matrix — sole path-policy tests for repo:/mount targets.
 * Covers single-source, multi-source, sources/<id>/ prefix, `..`, abs, empty id set.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeCitationTarget,
  formatCitationTarget,
  parseCitationSourcePath,
  parseCitationTarget,
  type CitationTargetOptions,
} from "./citation-target.js";

type MatrixRow = {
  name: string;
  raw: string;
  options: CitationTargetOptions;
  /** Expected parse (ok) or error substring (fail). */
  parse:
    | { ok: true; sourceId: string; repoPath: string }
    | { ok: false; errorIncludes: string | RegExp };
  /**
   * Expected canonicalize target string, or false when canonicalize must fail.
   * When omitted and parse.ok, derived via formatCitationTarget.
   */
  canonTarget?: string | false;
  /**
   * Expected parseCitationSourcePath legacy shape, or null when undefined.
   * When omitted: same as parse success → {sourceId,repoPath}, fail → null;
   * unbound bare (sourceId "" with non-empty ids) → null.
   */
  legacySplit?: { sourceId: string; repoPath: string } | null;
};

const MATRIX: MatrixRow[] = [
  // --- single-source ---
  {
    name: "single bare path",
    raw: "src/main.ts",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: true, sourceId: "main", repoPath: "src/main.ts" },
    canonTarget: "src/main.ts",
  },
  {
    name: "single strips sources/<id>/",
    raw: "sources/ebase-2/pom.xml",
    options: { sourceIds: ["ebase-2"], multiSource: false },
    parse: { ok: true, sourceId: "ebase-2", repoPath: "pom.xml" },
    canonTarget: "pom.xml",
  },
  {
    name: "single strips registered id prefix",
    raw: "ebase-2/pom.xml",
    options: { sourceIds: ["ebase-2"], multiSource: false },
    parse: { ok: true, sourceId: "ebase-2", repoPath: "pom.xml" },
    canonTarget: "pom.xml",
  },
  {
    name: "single real repo path sources/foo.ts is not stripped",
    raw: "sources/foo.ts",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: true, sourceId: "main", repoPath: "sources/foo.ts" },
    canonTarget: "sources/foo.ts",
  },
  {
    name: "single nested real path sources/dir/file.ts is not stripped",
    raw: "sources/dir/file.ts",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: true, sourceId: "main", repoPath: "sources/dir/file.ts" },
    canonTarget: "sources/dir/file.ts",
  },
  {
    name: "single nested mount form",
    raw: "sources/main/src/a/b.ts",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: true, sourceId: "main", repoPath: "src/a/b.ts" },
    canonTarget: "src/a/b.ts",
  },

  // --- multi-source ---
  {
    name: "multi strips sources/ keeps id",
    raw: "sources/a/x.ts",
    options: { sourceIds: ["a", "b"], multiSource: true },
    parse: { ok: true, sourceId: "a", repoPath: "x.ts" },
    canonTarget: "a/x.ts",
  },
  {
    name: "multi keeps id prefix",
    raw: "a/x.ts",
    options: { sourceIds: ["a", "b"], multiSource: true },
    parse: { ok: true, sourceId: "a", repoPath: "x.ts" },
    canonTarget: "a/x.ts",
  },
  {
    name: "multi bare path errors",
    raw: "orphan.ts",
    options: { sourceIds: ["a", "b"], multiSource: true },
    parse: { ok: false, errorIncludes: /multi-source citation must start with a source id/ },
    canonTarget: false,
    legacySplit: null,
  },
  {
    name: "multi unregistered mount id is not stripped (fails as bare)",
    raw: "sources/other/x.ts",
    options: { sourceIds: ["a", "b"], multiSource: true },
    parse: { ok: false, errorIncludes: /multi-source citation must start with a source id/ },
    canonTarget: false,
    legacySplit: null,
  },

  // --- empty id set ---
  {
    name: "empty id set bare path",
    raw: "README.md",
    options: { sourceIds: [], multiSource: false },
    parse: { ok: true, sourceId: "", repoPath: "README.md" },
    canonTarget: "README.md",
    legacySplit: { sourceId: "", repoPath: "README.md" },
  },
  {
    name: "empty id set multi bare fails",
    raw: "README.md",
    options: { sourceIds: [], multiSource: true },
    parse: { ok: false, errorIncludes: /multi-source citation must start with a source id/ },
    canonTarget: false,
    legacySplit: null,
  },
  {
    name: "empty id set cannot strip sources/ prefix",
    raw: "sources/main/a.ts",
    options: { sourceIds: [], multiSource: false },
    parse: { ok: true, sourceId: "", repoPath: "sources/main/a.ts" },
    canonTarget: "sources/main/a.ts",
    legacySplit: { sourceId: "", repoPath: "sources/main/a.ts" },
  },

  // --- rejects: .., absolute, empty after strip ---
  {
    name: "rejects parent escape ..",
    raw: "../etc/passwd",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: false, errorIncludes: /repository-relative POSIX/ },
    canonTarget: false,
    legacySplit: null,
  },
  {
    name: "rejects embedded .. segment",
    raw: "src/../secret.ts",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: false, errorIncludes: /repository-relative POSIX/ },
    canonTarget: false,
    legacySplit: null,
  },
  {
    name: "rejects absolute path",
    raw: "/abs/path",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: false, errorIncludes: /repository-relative POSIX/ },
    canonTarget: false,
    legacySplit: null,
  },
  {
    name: "rejects empty string",
    raw: "   ",
    options: { sourceIds: ["main"], multiSource: false },
    parse: { ok: false, errorIncludes: /empty citation path/ },
    canonTarget: false,
    legacySplit: null,
  },
  {
    name: "rejects empty after mount strip",
    raw: "sources/ebase-2",
    options: { sourceIds: ["ebase-2"], multiSource: false },
    parse: { ok: false, errorIncludes: /empty citation path after stripping sources\/ebase-2/ },
    canonTarget: false,
    legacySplit: null,
  },
  {
    // Trailing slash is collapsed by segment filter — "ebase-2/" ≡ bare "ebase-2"
    // (a repo-relative file named like the source id). Empty-after-id only applies
    // when a registered id is followed by a real empty rest before filtering is
    // impossible with filter(Boolean); mount form covers the empty-rest case.
    name: "trailing slash after sole id is bare filename not empty-rest",
    raw: "ebase-2/",
    options: { sourceIds: ["ebase-2"], multiSource: false },
    parse: { ok: true, sourceId: "ebase-2", repoPath: "ebase-2" },
    canonTarget: "ebase-2",
  },

  // --- unbound bare under multi registered ids, single-source mode ---
  {
    name: "single mode multi ids bare path: canonicalize ok, legacy split unbound",
    raw: "orphan.ts",
    options: { sourceIds: ["a", "b"], multiSource: false },
    parse: { ok: true, sourceId: "", repoPath: "orphan.ts" },
    canonTarget: "orphan.ts",
    legacySplit: null,
  },
];

for (const row of MATRIX) {
  test(`citation-target matrix: ${row.name}`, () => {
    const parsed = parseCitationTarget(row.raw, row.options);

    if (!row.parse.ok) {
      assert.equal(parsed.ok, false, `expected parse fail for ${row.raw}`);
      if (!parsed.ok) {
        if (typeof row.parse.errorIncludes === "string") {
          assert.ok(
            parsed.error.includes(row.parse.errorIncludes),
            `error ${parsed.error} should include ${row.parse.errorIncludes}`,
          );
        } else {
          assert.match(parsed.error, row.parse.errorIncludes);
        }
      }
    } else {
      assert.equal(parsed.ok, true, `expected parse ok for ${row.raw}`);
      if (parsed.ok) {
        assert.equal(parsed.sourceId, row.parse.sourceId);
        assert.equal(parsed.repoPath, row.parse.repoPath);
      }
    }

    const canon = canonicalizeCitationTarget(row.raw, row.options);
    if (row.canonTarget === false) {
      assert.equal(canon.ok, false);
    } else {
      const expectedTarget =
        row.canonTarget ??
        (row.parse.ok
          ? formatCitationTarget(
              { sourceId: row.parse.sourceId, repoPath: row.parse.repoPath },
              row.options,
            )
          : undefined);
      assert.equal(canon.ok, true, `canonicalize should succeed for ${row.raw}`);
      if (canon.ok) {
        assert.equal(canon.target, expectedTarget);
      }
      // parse → format round-trip matches canonicalize
      if (parsed.ok) {
        assert.equal(
          formatCitationTarget(
            { sourceId: parsed.sourceId, repoPath: parsed.repoPath },
            row.options,
          ),
          canon.ok ? canon.target : undefined,
        );
      }
    }

    const legacy =
      row.legacySplit !== undefined
        ? row.legacySplit
        : row.parse.ok
          ? row.parse.sourceId === "" && row.options.sourceIds.length > 0
            ? null
            : { sourceId: row.parse.sourceId, repoPath: row.parse.repoPath }
          : null;
    const split = parseCitationSourcePath(
      row.raw,
      row.options.sourceIds,
      row.options.multiSource,
    );
    assert.deepEqual(split ?? null, legacy);
  });
}

test("formatCitationTarget: multi vs single", () => {
  assert.equal(
    formatCitationTarget({ sourceId: "lib", repoPath: "src/a.go" }, { multiSource: true }),
    "lib/src/a.go",
  );
  assert.equal(
    formatCitationTarget({ sourceId: "lib", repoPath: "src/a.go" }, { multiSource: false }),
    "src/a.go",
  );
  assert.equal(
    formatCitationTarget({ sourceId: "", repoPath: "README.md" }, { multiSource: true }),
    "README.md",
  );
});

test("backslash separators normalize to POSIX", () => {
  const r = parseCitationTarget("sources\\main\\src\\a.ts", {
    sourceIds: ["main"],
    multiSource: false,
  });
  assert.deepEqual(r, { ok: true, sourceId: "main", repoPath: "src/a.ts" });
  assert.deepEqual(
    canonicalizeCitationTarget("sources\\main\\src\\a.ts", {
      sourceIds: ["main"],
      multiSource: false,
    }),
    { ok: true, target: "src/a.ts" },
  );
});
