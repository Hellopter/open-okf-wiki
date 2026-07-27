import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  applyStickyBlockingDefects,
  defectFingerprint,
  formatDefectsForRepair,
  hasBlockingDefects,
  mergeDefectReports,
  parseDefectReportFromText,
  writeMergedDefects,
} from "./defects.js";
import { defaultSpecStore } from "../ports/core-spec-store.js";
import { scorePublishable } from "./publishability.js";

test("parseDefectReportFromText recognizes NO_DEFECTS", () => {
  const r = parseDefectReportFromText("All good.\nNO_DEFECTS\n", "r1");
  assert.equal(r.clean, true);
  assert.equal(r.defects.length, 0);
});

test("parseDefectReportFromText parses fenced JSON", () => {
  const r = parseDefectReportFromText(
    [
      "```json",
      JSON.stringify({
        clean: false,
        defects: [
          {
            severity: "blocking",
            code: "thin_page",
            path: "overview.md",
            issue: "Too thin",
          },
        ],
      }),
      "```",
    ].join("\n"),
    "r1",
  );
  assert.equal(r.clean, false);
  assert.equal(r.defects[0]!.severity, "blocking");
  assert.equal(r.defects[0]!.path, "overview.md");
});

test("mergeDefectReports dedupes and ranks", () => {
  const a = parseDefectReportFromText("severity: blocking path: a.md issue one", "a");
  const b = parseDefectReportFromText("severity: minor path: b.md issue two", "b");
  const m = mergeDefectReports([a, b]);
  assert.equal(m.reviewerIds.length, 2);
  assert.ok(m.defects.length >= 1);
  assert.equal(hasBlockingDefects(m), true);
});

test("mergeDefectReports collapses same finding across reviewers", () => {
  const shared = {
    clean: false as const,
    defects: [
      {
        severity: "major" as const,
        code: "thin_page",
        path: "overview.md",
        issue: "Overview is too thin on runtime.",
      },
    ],
  };
  const a = parseDefectReportFromText(`\`\`\`json\n${JSON.stringify(shared)}\n\`\`\``, "r1");
  const b = parseDefectReportFromText(
    `\`\`\`json\n${JSON.stringify({
      ...shared,
      defects: [
        {
          severity: "blocking" as const,
          code: "thin_page",
          path: "overview.md",
          issue: "Overview is too thin on runtime.",
        },
      ],
    })}\n\`\`\``,
    "r2",
  );
  const m = mergeDefectReports([a, b]);
  assert.equal(m.defects.length, 1);
  assert.equal(m.defects[0]!.severity, "blocking");
  assert.equal(
    defectFingerprint(m.defects[0]!),
    defectFingerprint({
      code: "thin_page",
      path: "overview.md",
      issue: "Overview is too thin on runtime.",
    }),
  );
});

test("mergeDefectReports demotes singleton major when council ≥ 2", () => {
  const a = parseDefectReportFromText(
    `\`\`\`json\n${JSON.stringify({
      clean: false,
      defects: [
        {
          severity: "major",
          code: "style_nit",
          path: "overview.md",
          issue: "Prefer shorter sentences",
        },
      ],
    })}\n\`\`\``,
    "r1",
  );
  const b = parseDefectReportFromText("NO_DEFECTS", "r2");
  const m = mergeDefectReports([a, b]);
  assert.equal(m.defects.length, 1);
  assert.equal(m.defects[0]!.severity, "minor");
});

test("applyStickyBlockingDefects keeps prior blocking when round still dirty", () => {
  const prior = {
    version: 1 as const,
    clean: false,
    reviewerIds: ["r1"],
    defects: [
      {
        severity: "blocking" as const,
        code: "thin_page",
        path: "overview.md",
        issue: "Missing overview purpose",
        reviewerId: "r1",
      },
    ],
    summary: "1 defect",
  };
  const current = {
    version: 1 as const,
    clean: false,
    reviewerIds: ["r2"],
    defects: [
      {
        severity: "major" as const,
        code: "other",
        path: "modules/a.md",
        issue: "Something else",
        reviewerId: "r2",
      },
    ],
    summary: "1 defect",
  };
  const sticky = applyStickyBlockingDefects(current, prior);
  assert.equal(sticky.defects.length, 2);
  assert.ok(sticky.defects.some((d) => d.code?.startsWith("sticky_")));
});

test("applyStickyBlockingDefects drops sticky when current is clean", () => {
  const prior = {
    version: 1 as const,
    clean: false,
    reviewerIds: ["r1"],
    defects: [
      {
        severity: "blocking" as const,
        code: "thin_page",
        path: "overview.md",
        issue: "Missing overview purpose",
        reviewerId: "r1",
      },
    ],
  };
  const current = {
    version: 1 as const,
    clean: true,
    reviewerIds: ["r1", "r2"],
    defects: [] as [],
    summary: "NO_DEFECTS",
  };
  const next = applyStickyBlockingDefects(current, prior);
  assert.equal(next.clean, true);
  assert.equal(next.defects.length, 0);
});

test("formatDefectsForRepair defaults to blocking only", () => {
  const text = formatDefectsForRepair([
    {
      severity: "blocking",
      code: "a",
      path: "overview.md",
      issue: "bad",
    },
    {
      severity: "major",
      code: "b",
      path: "x.md",
      issue: "meh",
    },
  ]);
  assert.match(text, /overview\.md/);
  assert.doesNotMatch(text, /meh/);
});

test("scorePublishable fails without pages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-score-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(wikiRoot, { recursive: true });
  const scored = await scorePublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-1",
    sources: [],
    requireReviewReceipt: false,
  });
  assert.equal(scored.publishable, false);
  assert.ok(scored.reasons.some((r) => /no staged/i.test(r)));
});

test("scorePublishable passes with page + clean defects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-score-ok-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\n---\n\n# Overview\n\nHello ([Source](repo:README.md#L1-L1)).\n",
    "utf8",
  );
  const sourcePath = path.join(root, "src");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# hi\n", "utf8");

  const spec = defaultWikiRunSpec("Demo");
  await defaultSpecStore.commitSpec(root, "run-ok", spec);
  await writeMergedDefects(root, "run-ok", {
    version: 1,
    clean: true,
    defects: [],
    reviewerIds: ["r1"],
    summary: "NO_DEFECTS",
  });

  const scored = await scorePublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-ok",
    sources: [{ id: "main", path: sourcePath }],
    spec,
    requireReviewReceipt: true,
  });
  assert.equal(scored.publishable, true, scored.reasons.join("; "));
});
