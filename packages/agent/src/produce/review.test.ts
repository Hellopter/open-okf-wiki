import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defectsPath } from "./living-spec.js";
import { runReviewCouncil } from "./review.js";

test("runReviewCouncil: clean reviewers write NO_DEFECTS merge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-review-ok-"));
  await mkdir(path.join(root, ".okf-wiki"), { recursive: true });

  const merged = await runReviewCouncil({
    reviewers: [
      { id: "r1", text: "Looks good.\nNO_DEFECTS\n" },
      { id: "r2", text: "NO_DEFECTS" },
    ],
    pages: ["overview.md"],
    workspaceRoot: root,
    runId: "run-review-ok",
    round: 1,
  });

  assert.equal(merged.clean, true);
  assert.equal(merged.defects.length, 0);
  assert.ok(merged.reviewerIds.includes("r1"));
  assert.ok(merged.reviewerIds.includes("r2"));

  const onDisk = JSON.parse(await readFile(defectsPath(root, "run-review-ok"), "utf8")) as {
    clean: boolean;
  };
  assert.equal(onDisk.clean, true);
});

test("runReviewCouncil: blocking defect yields non-clean merge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-review-fail-"));
  await mkdir(path.join(root, ".okf-wiki"), { recursive: true });

  const defectJson = JSON.stringify({
    clean: false,
    defects: [
      {
        severity: "blocking",
        code: "thin_page",
        path: "overview.md",
        issue: "Too thin",
      },
    ],
  });

  const merged = await runReviewCouncil({
    reviewers: [{ id: "critic", text: "```json\n" + defectJson + "\n```" }],
    pages: ["overview.md"],
    workspaceRoot: root,
    runId: "run-review-fail",
  });

  assert.equal(merged.clean, false);
  assert.ok(merged.defects.length >= 1);
  assert.equal(merged.defects[0]!.severity, "blocking");
  assert.ok(merged.reviewerIds.includes("critic"));
});
