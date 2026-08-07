import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isAgentStale, sanitizeForMatch, scanSurveyCoverage } from "../dist/orch/index.js";

function tempWorkdir() {
  return mkdtempSync(join(tmpdir(), "pi-wiki-progress-"));
}

function writeReceipt(dir, filename, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(body, null, 2), "utf8");
}

test("sanitizeForMatch normalizes unit ids and filenames", () => {
  assert.equal(sanitizeForMatch("readmind::packages/shared"), "readmind-packages-shared");
  assert.equal(sanitizeForMatch("readmind-packages-shared"), "readmind-packages-shared");
  assert.equal(sanitizeForMatch("API_Core"), "api-core");
});

test("scanSurveyCoverage returns undefined when receipts dir is missing", async () => {
  const workdir = tempWorkdir();
  const result = await scanSurveyCoverage(workdir);
  assert.equal(result, undefined);
});

test("scanSurveyCoverage reads coverageUnit.id from receipts", async () => {
  const workdir = tempWorkdir();
  const receipts = join(workdir, "analysis", "receipts", "survey");
  writeReceipt(receipts, "a.json", {
    version: 1,
    kind: "survey-receipt",
    coverageUnit: { id: "src::a", kind: "surface", sourceId: "src", path: "a", label: "A" },
    status: "ok",
  });
  writeReceipt(receipts, "b.json", {
    version: 1,
    kind: "survey-receipt",
    coverageUnit: { id: "src::b", kind: "surface", sourceId: "src", path: "b", label: "B" },
    status: "ok",
  });

  const view = await scanSurveyCoverage(workdir, { pass: 2 });
  assert.ok(view);
  assert.equal(view.pass, 2);
  assert.equal(view.unitsTotal, 2);
  assert.equal(view.unitsWithReceipt, 2);
  assert.deepEqual(view.missingUnitIds, []);
  assert.deepEqual(view.retryUnitIds, []);
});

test("scanSurveyCoverage computes missing against inventoryUnits", async () => {
  const workdir = tempWorkdir();
  const receipts = join(workdir, "analysis", "receipts", "survey");
  writeReceipt(receipts, "covered.json", {
    coverageUnit: { id: "unit-a" },
  });

  const view = await scanSurveyCoverage(workdir, {
    pass: 1,
    inventoryUnits: [{ id: "unit-a" }, { id: "unit-b" }, { id: "unit-c" }],
  });

  assert.ok(view);
  assert.equal(view.unitsTotal, 3);
  assert.equal(view.unitsWithReceipt, 1);
  assert.deepEqual(view.missingUnitIds.sort(), ["unit-b", "unit-c"]);
  assert.deepEqual(view.retryUnitIds, []);
});

test("scanSurveyCoverage filename heuristic covers inventory units", async () => {
  const workdir = tempWorkdir();
  const receipts = join(workdir, "analysis", "receipts", "survey");
  // Filename matches sanitized unit id; body has no coverageUnit
  writeReceipt(receipts, "readmind-packages-shared.json", {
    version: 1,
    kind: "survey-receipt",
    status: "ok",
    summary: "no coverageUnit field",
  });

  const view = await scanSurveyCoverage(workdir, {
    inventoryUnits: [
      { id: "readmind::packages/shared" },
      { id: "readmind::packages/ai" },
    ],
  });

  assert.ok(view);
  assert.equal(view.unitsTotal, 2);
  assert.equal(view.unitsWithReceipt, 1);
  assert.deepEqual(view.missingUnitIds, ["readmind::packages/ai"]);
});

test("scanSurveyCoverage prefers coverageUnit.id over filename", async () => {
  const workdir = tempWorkdir();
  const receipts = join(workdir, "analysis", "receipts", "survey");
  writeReceipt(receipts, "wrong-name.json", {
    coverageUnit: { id: "real-unit-id" },
  });

  const view = await scanSurveyCoverage(workdir, {
    inventoryUnits: [{ id: "real-unit-id" }, { id: "wrong-name" }],
  });

  assert.ok(view);
  assert.equal(view.unitsWithReceipt, 1);
  assert.deepEqual(view.missingUnitIds, ["wrong-name"]);
});

test("scanSurveyCoverage without inventory uses unique found ids", async () => {
  const workdir = tempWorkdir();
  const receipts = join(workdir, "analysis", "receipts", "survey");
  writeReceipt(receipts, "one.json", { coverageUnit: { id: "u1" } });
  writeReceipt(receipts, "two.json", { coverageUnit: { id: "u1" } }); // duplicate unit
  writeReceipt(receipts, "three.json", { coverageUnit: { id: "u2" } });

  const view = await scanSurveyCoverage(workdir);
  assert.ok(view);
  assert.equal(view.pass, 1);
  assert.equal(view.unitsTotal, 2);
  assert.equal(view.unitsWithReceipt, 2);
  assert.deepEqual(view.missingUnitIds, []);
});

test("isAgentStale only for in-flight statuses and uses heartbeat/tool/start", () => {
  const now = 1_000_000;
  const staleWarnMs = 10_000;

  assert.equal(
    isAgentStale(
      {
        agentId: "1",
        label: "1",
        role: "survey",
        phase: "survey",
        status: "succeeded",
        elapsedMs: 0,
        receiptsWritten: 0,
        lastHeartbeatAt: now - 60_000,
      },
      staleWarnMs,
      now,
    ),
    false,
  );

  assert.equal(
    isAgentStale(
      {
        agentId: "2",
        label: "2",
        role: "survey",
        phase: "survey",
        status: "running",
        elapsedMs: 0,
        receiptsWritten: 0,
        lastHeartbeatAt: now - 5_000,
      },
      staleWarnMs,
      now,
    ),
    false,
  );

  assert.equal(
    isAgentStale(
      {
        agentId: "3",
        label: "3",
        role: "survey",
        phase: "survey",
        status: "waiting_tool",
        elapsedMs: 0,
        receiptsWritten: 0,
        lastTool: { name: "read", at: now - 30_000 },
      },
      staleWarnMs,
      now,
    ),
    true,
  );

  assert.equal(
    isAgentStale(
      {
        agentId: "4",
        label: "4",
        role: "survey",
        phase: "survey",
        status: "starting",
        elapsedMs: 0,
        receiptsWritten: 0,
        startedAt: now - 90_000,
      },
      staleWarnMs,
      now,
    ),
    true,
  );

  // No timestamps on a running agent => stale
  assert.equal(
    isAgentStale(
      {
        agentId: "5",
        label: "5",
        role: "survey",
        phase: "survey",
        status: "running",
        elapsedMs: 0,
        receiptsWritten: 0,
      },
      staleWarnMs,
      now,
    ),
    true,
  );
});
