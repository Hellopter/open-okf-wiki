import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createFixtureProduceRuntime } from "./produce-runtime.js";

describe("ProduceRuntime fixture agent", () => {
  it("emits progress and summary", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-rsa-"));
    const spans: Array<{ id: string; status: string }> = [];
    const runtime = createFixtureProduceRuntime();
    const r = await runtime.runAgent({
      role: "domain",
      spanId: "domain-auth",
      runWorkDir: dir,
      task: "Investigate auth module",
      onProgress: (span) => spans.push({ id: span.attemptId, status: span.status }),
    });
    assert.equal(r.mode, "fixture");
    assert.match(r.summary, /domain/);
    assert.ok(spans.some((s) => s.id === "domain-auth" && s.status === "done"));
  });

  it("parallel fan-out preserves order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-par-"));
    const runtime = createFixtureProduceRuntime();
    const out = await runtime.runAgentsParallel(
      [
        { role: "leaf", runWorkDir: dir, task: "A" },
        { role: "leaf", runWorkDir: dir, task: "B" },
        { role: "reviewer", runWorkDir: dir, task: "C" },
      ],
      { concurrency: 2 },
    );
    assert.equal(out.length, 3);
    assert.match(out[0]!.summary, /A/);
    assert.match(out[1]!.summary, /B/);
    assert.match(out[2]!.summary, /C/);
  });

  it("abort before start throws AbortError", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-ab-"));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () =>
        createFixtureProduceRuntime().runAgent({
          role: "domain",
          runWorkDir: dir,
          task: "x",
          abortSignal: ac.signal,
        }),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
  });
});
