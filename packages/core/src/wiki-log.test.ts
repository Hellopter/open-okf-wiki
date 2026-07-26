import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  diffWikiPages,
  renderWikiLog,
  stripProvenanceForDiff,
  updateWikiLogForPublish,
  WIKI_LOG_HEADING,
} from "./wiki-log.js";

test("stripProvenanceForDiff removes stamped lines only", () => {
  const stamped = [
    "---",
    "type: Concept",
    "title: T",
    'generated: { by: "okf-wiki/m", at: "2026-07-26T12:00:00Z" }',
    "verified:",
    '  - { by: "process:review-council", at: "2026-07-26T12:30:00Z" }',
    "---",
    "Body.",
  ].join("\n");
  const plain = "---\ntype: Concept\ntitle: T\n---\nBody.";
  assert.equal(stripProvenanceForDiff(stamped), plain);
});

test("diffWikiPages classifies creation/update/removal and skips reserved", () => {
  const previous = new Map([
    ["stays.md", "same"],
    ["changes.md", "before"],
    ["gone.md", "bye"],
    ["index.md", "old listing"],
  ]);
  const next = new Map([
    ["stays.md", "same"],
    ["changes.md", "after"],
    ["new.md", "hello"],
    ["index.md", "new listing"],
  ]);
  const titles = new Map([["new.md", "New Page"]]);
  assert.deepEqual(diffWikiPages(previous, next, titles), [
    { kind: "Update", path: "changes.md" },
    { kind: "Removal", path: "gone.md" },
    { kind: "Creation", path: "new.md", title: "New Page" },
  ]);
});

test("renderWikiLog prepends a date section and carries prior sections forward", () => {
  const previousLog = `${WIKI_LOG_HEADING}\n\n## 2026-07-01\n* **Creation**: Added [O](/overview.md).\n`;
  const log = renderWikiLog({
    date: "2026-07-26",
    changes: [{ kind: "Update", path: "overview.md", title: "O" }],
    previousLog,
  });
  const updateIdx = log.indexOf("## 2026-07-26");
  const priorIdx = log.indexOf("## 2026-07-01");
  assert.ok(log.startsWith(WIKI_LOG_HEADING));
  assert.ok(updateIdx > 0 && priorIdx > updateIdx, "newest first");
  assert.match(log, /\* \*\*Update\*\*: Updated \[O\]\(\/overview\.md\)\./);
});

test("renderWikiLog merges same-date sections without duplicate lines", () => {
  const previousLog = renderWikiLog({
    date: "2026-07-26",
    changes: [
      { kind: "Creation", path: "a.md", title: "A" },
      { kind: "Creation", path: "b.md", title: "B" },
    ],
  });
  const log = renderWikiLog({
    date: "2026-07-26",
    changes: [
      { kind: "Creation", path: "a.md", title: "A" },
      { kind: "Update", path: "b.md", title: "B" },
    ],
    previousLog,
  });
  assert.equal(log.match(/## 2026-07-26/g)?.length, 1);
  assert.equal(log.match(/\* \*\*Creation\*\*: Added \[A\]\(\/a\.md\)\./g)?.length, 1);
  assert.match(log, /\* \*\*Update\*\*: Updated \[B\]/);
  assert.match(log, /\* \*\*Creation\*\*: Added \[B\]/);
});

test("updateWikiLogForPublish diffs candidate vs live and writes candidate log.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-log-"));
  const live = path.join(root, "live");
  const candidate = path.join(root, "candidate");
  await mkdir(live, { recursive: true });
  await mkdir(candidate, { recursive: true });
  await writeFile(
    path.join(live, "overview.md"),
    '---\ntype: Overview\ntitle: O\ngenerated: { by: "okf-wiki/m", at: "2026-07-01T00:00:00Z" }\n---\nSame body.\n',
  );
  // Candidate: same page (unstamped), one new page.
  await writeFile(
    path.join(candidate, "overview.md"),
    "---\ntype: Overview\ntitle: O\n---\nSame body.\n",
  );
  await writeFile(
    path.join(candidate, "modules.md"),
    "---\ntype: Module\ntitle: Modules\n---\nBody.\n",
  );

  const result = await updateWikiLogForPublish({
    candidateDir: candidate,
    previousDir: live,
    date: "2026-07-26",
  });
  assert.equal(result.changes, 1);
  const log = await readFile(path.join(candidate, "log.md"), "utf8");
  assert.match(log, /## 2026-07-26\n\* \*\*Creation\*\*: Added \[Modules\]\(\/modules\.md\)\./);
  // Stamp-only difference on overview.md is not an Update.
  assert.doesNotMatch(log, /overview\.md/);
});
