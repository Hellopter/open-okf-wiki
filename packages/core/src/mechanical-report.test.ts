import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractPagesFromValidationMessage,
  extractPathFromValidateError,
  mechanicalIssuesFromErrors,
  toMechanicalReport,
} from "./mechanical-report.js";

test("mechanicalIssuesFromErrors classifies citation OOB as autoFixable clamp_lines", () => {
  const issues = mechanicalIssuesFromErrors([
    "overview.md: citation line range out of bounds ([Source](repo:a.ts#L99); file has 10 lines)",
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, "citation_oob");
  assert.equal(issues[0]!.autoFixable, true);
  assert.equal(issues[0]!.fixHint, "clamp_lines");
  assert.equal(issues[0]!.path, "overview.md");
});

test("mechanicalIssuesFromErrors maps each heuristic code", () => {
  const cases: Array<{ error: string; code: string; path?: string }> = [
    {
      error: "mod/x.md: citation target not found in Snapshot ([Source](repo:missing.ts#L1))",
      code: "citation_unresolved",
      path: "mod/x.md",
    },
    {
      error: "a.md: multi-source citation must start with a source id (got foo)",
      code: "citation_format",
      path: "a.md",
    },
    {
      error: "b.md: citation path must be repository-relative POSIX (got /abs)",
      code: "citation_format",
      path: "b.md",
    },
    {
      error: "c.md: missing Source Citation ([Source](repo:…#L…))",
      code: "missing_citation",
      path: "c.md",
    },
    {
      error: "d.md: missing YAML frontmatter with non-empty type and title",
      code: "missing_frontmatter",
      path: "d.md",
    },
    {
      error: "e.md: missing YAML frontmatter with non-empty type",
      code: "missing_frontmatter",
      path: "e.md",
    },
    { error: "critical page missing: architecture.md", code: "missing_critical_page" },
    { error: "symlink not allowed in wiki tree: link.md", code: "symlink" },
    { error: "wiki tree has 600 files (max 500)", code: "cap_exceeded" },
    { error: "big.md exceeds max file size (2000000 > 1000000 bytes)", code: "cap_exceeded" },
    { error: "something unexpected happened", code: "other" },
  ];

  for (const c of cases) {
    const [issue] = mechanicalIssuesFromErrors([c.error]);
    assert.ok(issue, `expected issue for: ${c.error}`);
    assert.equal(issue.code, c.code, c.error);
    if (c.path) assert.equal(issue.path, c.path, c.error);
    assert.equal(issue.autoFixable, c.code === "citation_oob");
  }
});

test("extractPathFromValidateError only takes path.md: prefixes", () => {
  assert.equal(extractPathFromValidateError("overview.md: boom"), "overview.md");
  assert.equal(extractPathFromValidateError("domain/foo.md: boom"), "domain/foo.md");
  assert.equal(extractPathFromValidateError("critical page missing: architecture.md"), undefined);
  assert.equal(extractPathFromValidateError("wikiDir is a symlink: /tmp/x"), undefined);
});

test("toMechanicalReport mirrors ValidateWikiResult into MechanicalReport", () => {
  const report = toMechanicalReport(
    {
      ok: false,
      errors: [
        "overview.md: citation line range out of bounds (x)",
        "critical page missing: architecture.md",
      ],
      warnings: ["overview.md: missing frontmatter description (OKF v0.2 recommended)"],
      pageCount: 2,
      fileCount: 3,
      citationCount: 1,
    },
    { candidateId: "cand-1" },
  );
  assert.equal(report.ok, false);
  assert.equal(report.candidateId, "cand-1");
  assert.equal(report.issues.length, 2);
  assert.equal(report.issues[0]!.code, "citation_oob");
  assert.equal(report.issues[1]!.code, "missing_critical_page");
  assert.deepEqual(report.errors, [
    "overview.md: citation line range out of bounds (x)",
    "critical page missing: architecture.md",
  ]);
  assert.equal(report.pageCount, 2);
  assert.equal(report.warnings.length, 1);
});

test("toMechanicalReport ok true yields empty issues", () => {
  const report = toMechanicalReport({
    ok: true,
    errors: [],
    warnings: [],
    pageCount: 1,
    fileCount: 1,
    citationCount: 0,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.errors, []);
});

test("extractPagesFromValidationMessage caps and dedupes path.md segments", () => {
  const message =
    "validation failed: overview.md: missing type; architecture.md: missing title; overview.md: again; deep/x.md: boom";
  const pages = extractPagesFromValidationMessage(message, 8);
  assert.deepEqual(pages, ["overview.md", "architecture.md", "deep/x.md"]);

  const capped = extractPagesFromValidationMessage(
    Array.from({ length: 12 }, (_, i) => `p${i}.md: err`).join("; "),
    8,
  );
  assert.equal(capped.length, 8);
  assert.equal(capped[0], "p0.md");
  assert.equal(capped[7], "p7.md");
});
