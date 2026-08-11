import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  matchingSourceRoot,
  parseEvidenceReference,
  validateResearchArtifact,
} from "../dist/research-evidence.js";

function artifact(findings, gaps = []) {
  return {
    summary: "Research summary",
    findings,
    gaps,
  };
}

function finding(evidence, overrides = {}) {
  return {
    kind: "concept",
    title: "Title",
    readerQuestion: "What?",
    priority: "normal",
    evidence: Array.isArray(evidence) ? evidence : [evidence],
    ...overrides,
  };
}

async function workspace(t, layout) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-evidence-"));
  t.after(async () => await rm(cwd, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(layout)) {
    const absolute = path.join(cwd, ...rel.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return cwd;
}

test("parseEvidenceReference accepts single-line and range forms", () => {
  assert.deepEqual(parseEvidenceReference("api/src/index.ts#L1"), {
    path: "api/src/index.ts",
    start: 1,
    end: 1,
    raw: "api/src/index.ts#L1",
  });
  assert.deepEqual(parseEvidenceReference("  api/src/index.ts#L2-L4  "), {
    path: "api/src/index.ts",
    start: 2,
    end: 4,
    raw: "api/src/index.ts#L2-L4",
  });
});

test("parseEvidenceReference rejects invalid formats", () => {
  assert.throws(() => parseEvidenceReference("api/src/index.ts"), /invalid/);
  assert.throws(() => parseEvidenceReference("api/src/index.ts#1"), /invalid/);
  assert.throws(() => parseEvidenceReference("/abs/path#L1"), /invalid/);
  assert.throws(() => parseEvidenceReference("api/../escape#L1"), /invalid/);
  assert.throws(() => parseEvidenceReference("api/src/index.ts#L5-L2"), /invalid line range/);
});

test("matchingSourceRoot prefers the longest declared prefix", () => {
  const roots = ["api", "api/src", "web"];
  assert.equal(matchingSourceRoot("api/src/index.ts", roots), "api/src");
  assert.equal(matchingSourceRoot("api/other.ts", roots), "api");
  assert.equal(matchingSourceRoot("web/app.ts", roots), "web");
  assert.equal(matchingSourceRoot("lib/util.ts", roots), undefined);
});

test("valid evidence under assigned scope is accepted", async (t) => {
  const cwd = await workspace(t, {
    "api/src/index.ts": "export const api = true;\nexport const version = 1;\n",
  });
  assert.doesNotThrow(() => validateResearchArtifact(
    artifact([finding("api/src/index.ts#L1-L2")]),
    { cwd, allowedSourceRoots: ["api"] },
  ));
});

test("invalid evidence format is reported on the finding index", async (t) => {
  const cwd = await workspace(t, {
    "api/src/index.ts": "export const api = true;\n",
  });
  assert.throws(
    () => validateResearchArtifact(
      artifact([finding("api/src/index.ts")]),
      { cwd, allowedSourceRoots: ["api"] },
    ),
    (error) => error instanceof Error
      && error.message.includes("findings[0]:")
      && /invalid/.test(error.message),
  );
});

test("evidence outside assigned scope is rejected", async (t) => {
  const cwd = await workspace(t, {
    "api/src/index.ts": "export const api = true;\n",
    "web/src/index.ts": "export const web = true;\n",
  });
  assert.throws(
    () => validateResearchArtifact(
      artifact([finding("web/src/index.ts#L1")]),
      { cwd, allowedSourceRoots: ["api"] },
    ),
    /outside the assigned scope/,
  );
});

test("longest-prefix scope: short root does not authorize a sibling path under another root", async (t) => {
  // Declared roots include both `api` and a more specific tree. Evidence under
  // `api-extra` must not match root `api` via naive prefix comparison.
  const cwd = await workspace(t, {
    "api/index.ts": "export const api = true;\n",
    "api-extra/index.ts": "export const extra = true;\n",
  });
  assert.throws(
    () => validateResearchArtifact(
      artifact([finding("api-extra/index.ts#L1")]),
      { cwd, allowedSourceRoots: ["api"] },
    ),
    /outside the assigned scope/,
  );
  assert.doesNotThrow(() => validateResearchArtifact(
    artifact([finding("api/index.ts#L1")]),
    { cwd, allowedSourceRoots: ["api"] },
  ));
  // When both roots are allowed, longest prefix still selects the correct root.
  assert.doesNotThrow(() => validateResearchArtifact(
    artifact([finding("api-extra/index.ts#L1")]),
    { cwd, allowedSourceRoots: ["api", "api-extra"] },
  ));
});

test("missing evidence file reports a specific missing-file message", async (t) => {
  const cwd = await workspace(t, {
    "api/src/index.ts": "export const api = true;\n",
  });
  assert.throws(
    () => validateResearchArtifact(
      artifact([finding("api/src/missing.ts#L1")]),
      { cwd, allowedSourceRoots: ["api"] },
    ),
    (error) => error instanceof Error
      && /Research evidence file is missing/.test(error.message)
      && error.message.includes("api/src/missing.ts#L1"),
  );
});

test("line range that exceeds the file includes the line count in the message", async (t) => {
  const cwd = await workspace(t, {
    "api/src/index.ts": "line1\nline2\n",
  });
  assert.throws(
    () => validateResearchArtifact(
      artifact([finding("api/src/index.ts#L99")]),
      { cwd, allowedSourceRoots: ["api"] },
    ),
    (error) => error instanceof Error
      && /line range exceeds file \(2 lines\)/.test(error.message)
      && error.message.includes("api/src/index.ts#L99"),
  );
});

test("symlink source root still validates evidence against physical files", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-evidence-link-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const realSource = path.join(parent, "real-api");
  const cwd = path.join(parent, "workspace");
  await mkdir(path.join(realSource, "src"), { recursive: true });
  await writeFile(path.join(realSource, "src", "index.ts"), "export const linked = true;\nsecond\n", "utf8");
  await mkdir(cwd, { recursive: true });
  await symlink(realSource, path.join(cwd, "api"));

  assert.doesNotThrow(() => validateResearchArtifact(
    artifact([finding("api/src/index.ts#L1-L2")]),
    { cwd, allowedSourceRoots: ["api"] },
  ));
  assert.throws(
    () => validateResearchArtifact(
      artifact([finding("api/src/index.ts#L99")]),
      { cwd, allowedSourceRoots: ["api"] },
    ),
    /line range exceeds file \(2 lines\)/,
  );
});

test("gap source paths outside scope are rejected", async (t) => {
  const cwd = await workspace(t, {
    "api/src/index.ts": "export const api = true;\n",
  });
  assert.throws(
    () => validateResearchArtifact(
      artifact(
        [finding("api/src/index.ts#L1")],
        [{ priority: "critical", question: "What about web?", sourcePaths: ["web"] }],
      ),
      { cwd, allowedSourceRoots: ["api"] },
    ),
    /gaps\[0\].*outside the assigned scope/,
  );
});
