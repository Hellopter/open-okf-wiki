import assert from "node:assert/strict";
import test from "node:test";
import { relativeSourceHref, rewriteRepoCitationsToRelative } from "./citation-rewrite.js";

test("relativeSourceHref from root and nested pages", () => {
  assert.equal(relativeSourceHref("overview.md", "app", "README.md"), "sources/app/README.md");
  assert.equal(
    relativeSourceHref("modules/runtime.md", "app", "src/main.ts"),
    "../sources/app/src/main.ts",
  );
  assert.equal(relativeSourceHref("a/b/c.md", "lib", "pkg/x.go"), "../../sources/lib/pkg/x.go");
});

test("rewriteRepoCitationsToRelative rewrites single-source bare paths", () => {
  const md = "Hello ([Source](repo:README.md#L1-L2)) and ([Source](repo:src/a.ts#L3)).";
  const out = rewriteRepoCitationsToRelative(md, {
    pageRelPath: "overview.md",
    sources: [{ id: "app" }],
  });
  assert.equal(
    out,
    "Hello ([Source](sources/app/README.md#L1-L2)) and ([Source](sources/app/src/a.ts#L3)).",
  );
});

test("rewriteRepoCitationsToRelative nested page uses ../sources", () => {
  const md = "Fact [Source](repo:pkg/x.ts#L10).";
  const out = rewriteRepoCitationsToRelative(md, {
    pageRelPath: "modules/foo.md",
    sources: [{ id: "app" }],
  });
  assert.equal(out, "Fact [Source](../sources/app/pkg/x.ts#L10).");
});

test("rewriteRepoCitationsToRelative multi-source id prefix", () => {
  const md = "A [Source](repo:lib/src/a.go#L1-L2).";
  const out = rewriteRepoCitationsToRelative(md, {
    pageRelPath: "overview.md",
    sources: [{ id: "app" }, { id: "lib" }],
  });
  assert.equal(out, "A [Source](sources/lib/src/a.go#L1-L2).");
});

test("rewriteRepoCitationsToRelative leaves unresolvable multi bare path", () => {
  const md = "A [Source](repo:orphan.ts#L1).";
  const out = rewriteRepoCitationsToRelative(md, {
    pageRelPath: "overview.md",
    sources: [{ id: "app" }, { id: "lib" }],
  });
  assert.equal(out, md);
});

test("rewriteRepoCitationsToRelative does not double-prefix mount-form targets", () => {
  // Producer wrote run-mount path inside repo: — canonicalize then rewrite once.
  const md = "A [Source](repo:sources/app/README.md#L1-L2).";
  const out = rewriteRepoCitationsToRelative(md, {
    pageRelPath: "overview.md",
    sources: [{ id: "app" }],
  });
  assert.equal(out, "A [Source](sources/app/README.md#L1-L2).");
  assert.ok(!out.includes("sources/app/sources/"));
});

test("rewriteRepoCitationsToRelative multi mount-form does not double-prefix", () => {
  const md = "A [Source](repo:sources/lib/src/a.go#L1).";
  const out = rewriteRepoCitationsToRelative(md, {
    pageRelPath: "modules/foo.md",
    sources: [{ id: "app" }, { id: "lib" }],
  });
  assert.equal(out, "A [Source](../sources/lib/src/a.go#L1).");
  assert.ok(!out.includes("sources/lib/sources/"));
});
