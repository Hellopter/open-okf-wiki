import assert from "node:assert/strict";
import test from "node:test";
import {
  SourceAddSchema,
  SourceCloneSchema,
  SourceUpdateSchema,
  WorkspaceCreateSchema,
  WorkspacePatchRequestSchema,
  WorkspacePatchSchema,
} from "./intake.js";

test("WorkspaceCreateSchema requires name, rootPath, and explicit Run capacity", () => {
  assert.equal(WorkspaceCreateSchema.safeParse({}).success, false);
  assert.equal(WorkspaceCreateSchema.safeParse({ name: "w", rootPath: "/tmp/ws" }).success, false);
  assert.equal(
    WorkspaceCreateSchema.safeParse({
      name: "w",
      rootPath: "/tmp/ws",
      orchestration: { maxActiveRuns: 1, maxConcurrentAttempts: 1 },
    }).success,
    true,
  );
});

test("WorkspacePatchSchema rejects unknown keys", () => {
  assert.equal(WorkspacePatchSchema.safeParse({ name: "x" }).success, true);
  assert.equal(WorkspacePatchRequestSchema.safeParse({ name: "x" }).success, false);
  assert.equal(
    WorkspacePatchRequestSchema.safeParse({ expectedRevision: 0, name: "x" }).success,
    true,
  );
  assert.equal(WorkspacePatchSchema.safeParse({ rootPath: "/nope" }).success, false);
});

test("SourceAddSchema requires path", () => {
  assert.equal(SourceAddSchema.safeParse({}).success, false);
  assert.equal(SourceAddSchema.safeParse({ path: "/repo" }).success, false);
  assert.equal(SourceAddSchema.safeParse({ expectedRevision: 0, path: "/repo" }).success, true);
});

test("SourceCloneSchema requires remoteUrl", () => {
  assert.equal(SourceCloneSchema.safeParse({}).success, false);
  assert.equal(
    SourceCloneSchema.safeParse({ expectedRevision: 0, remoteUrl: "https://example.com/r.git" })
      .success,
    true,
  );
});

test("SourceUpdateSchema requires at least one field", () => {
  assert.equal(SourceUpdateSchema.safeParse({}).success, false);
  assert.equal(SourceUpdateSchema.safeParse({ applyDefaultIgnores: true }).success, false);
  assert.equal(
    SourceUpdateSchema.safeParse({ expectedRevision: 0, applyDefaultIgnores: true }).success,
    true,
  );
  assert.equal(
    SourceUpdateSchema.safeParse({ expectedRevision: 0, ignore: ["node_modules"] }).success,
    true,
  );
  assert.equal(
    SourceUpdateSchema.safeParse({ expectedRevision: 0, applyDefaultIgnores: "yes" }).success,
    false,
  );
  assert.equal(SourceUpdateSchema.safeParse({ expectedRevision: 0, ignore: [1] }).success, false);
  assert.equal(SourceUpdateSchema.safeParse({ expectedRevision: 0, path: "/nope" }).success, false);
});
