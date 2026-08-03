import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractPagesFromMechanicalIssues,
  extractPagesFromValidationMessage,
  extractPathFromValidateError,
  makeMechanicalIssue,
  toMechanicalReport,
} from "./mechanical-report.js";

test("makeMechanicalIssue clamps lengths and defaults autoFixable", () => {
  const issue = makeMechanicalIssue({
    code: "missing_frontmatter",
    path: "overview.md",
    message: "overview.md: missing YAML frontmatter with non-empty type",
  });
  assert.equal(issue.code, "missing_frontmatter");
  assert.equal(issue.path, "overview.md");
  assert.equal(issue.autoFixable, false);
  assert.equal(issue.message.startsWith("overview.md:"), true);
  assert.ok(issue.raw);
});

test("makeMechanicalIssue preserves autoFixable clamp_lines for citation_oob", () => {
  const issue = makeMechanicalIssue({
    code: "citation_oob",
    path: "overview.md",
    message: "overview.md: citation line range out of bounds (x)",
    autoFixable: true,
    fixHint: "clamp_lines",
  });
  assert.equal(issue.code, "citation_oob");
  assert.equal(issue.autoFixable, true);
  assert.equal(issue.fixHint, "clamp_lines");
});

test("toMechanicalReport consumes structured issues without string heuristics", () => {
  const issues = [
    makeMechanicalIssue({
      code: "citation_oob",
      path: "overview.md",
      message: "overview.md: citation line range out of bounds (x)",
      autoFixable: true,
      fixHint: "clamp_lines",
    }),
    makeMechanicalIssue({
      code: "missing_critical_page",
      path: "architecture.md",
      message: "critical page missing: architecture.md",
    }),
  ];
  const report = toMechanicalReport(
    {
      ok: false,
      issues,
      errors: issues.map((i) => i.message),
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
  assert.equal(report.issues[0]!.autoFixable, true);
  assert.equal(report.issues[0]!.fixHint, "clamp_lines");
  assert.equal(report.issues[1]!.code, "missing_critical_page");
  assert.deepEqual(report.errors, [
    "overview.md: citation line range out of bounds (x)",
    "critical page missing: architecture.md",
  ]);
  assert.equal(report.pageCount, 2);
  assert.equal(report.warnings.length, 1);
});

test("toMechanicalReport derives errors from issues when omitted", () => {
  const issues = [
    makeMechanicalIssue({
      code: "missing_citation",
      path: "a.md",
      message: "a.md: missing Source Citation",
    }),
  ];
  const report = toMechanicalReport({ ok: false, issues });
  assert.deepEqual(report.errors, ["a.md: missing Source Citation"]);
});

test("toMechanicalReport ok true yields empty issues", () => {
  const report = toMechanicalReport({
    ok: true,
    issues: [],
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

test("extractPagesFromMechanicalIssues uses structured path fields", () => {
  const pages = extractPagesFromMechanicalIssues([
    makeMechanicalIssue({
      code: "missing_frontmatter",
      path: "overview.md",
      message: "overview.md: missing type",
    }),
    makeMechanicalIssue({
      code: "missing_frontmatter",
      path: "architecture.md",
      message: "architecture.md: missing title",
    }),
    makeMechanicalIssue({
      code: "missing_frontmatter",
      path: "overview.md",
      message: "overview.md: again",
    }),
    makeMechanicalIssue({
      code: "cap_exceeded",
      message: "wiki tree has 600 files (max 500)",
    }),
  ]);
  assert.deepEqual(pages, ["overview.md", "architecture.md"]);
});

test("extractPathFromValidateError only takes path.md: prefixes (legacy free-text)", () => {
  assert.equal(extractPathFromValidateError("overview.md: boom"), "overview.md");
  assert.equal(extractPathFromValidateError("domain/foo.md: boom"), "domain/foo.md");
  assert.equal(extractPathFromValidateError("critical page missing: architecture.md"), undefined);
  assert.equal(extractPathFromValidateError("wikiDir is a symlink: /tmp/x"), undefined);
});

test("extractPagesFromValidationMessage preserves every unique path (legacy free-text)", () => {
  const message =
    "validation failed: overview.md: missing type; architecture.md: missing title; overview.md: again; deep/x.md: boom";
  const pages = extractPagesFromValidationMessage(message);
  assert.deepEqual(pages, ["overview.md", "architecture.md", "deep/x.md"]);

  const paths = extractPagesFromValidationMessage(
    Array.from({ length: 12 }, (_, i) => `p${i}.md: err`).join("; "),
  );
  assert.equal(paths.length, 12);
  assert.equal(paths[0], "p0.md");
  assert.equal(paths[11], "p11.md");
});
