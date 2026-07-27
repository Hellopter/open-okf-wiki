import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunPhase } from "@okf-wiki/contract";
import { createRunPhaseController } from "./run-phase-writer.js";

describe("createRunPhaseController", () => {
  it("setPhase + record status projection + optional persist", async () => {
    const phases: WikiRunPhase[] = [];
    const records: Array<Record<string, unknown>> = [];
    let persists = 0;

    const { advancePhase } = createRunPhaseController({
      setPhase: (phase, extra) => {
        phases.push(phase);
        assert.equal(extra?.summary, "Producing Wiki");
      },
      updateRunRecord: async (patch) => {
        records.push(patch);
      },
      persist: async () => {
        persists += 1;
      },
      canWriteRecord: () => true,
    });

    await advancePhase("producing", {
      extra: { summary: "Producing Wiki" },
      record: { summary: "Producing Wiki" },
      persist: true,
    });

    assert.deepEqual(phases, ["producing"]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "running");
    assert.equal(records[0]?.summary, "Producing Wiki");
    assert.equal(persists, 1);
  });

  it("record: false skips Run Record write", async () => {
    let recordCalls = 0;
    const { advancePhase } = createRunPhaseController({
      setPhase: () => undefined,
      updateRunRecord: async () => {
        recordCalls += 1;
      },
      persist: async () => undefined,
      canWriteRecord: () => true,
    });

    await advancePhase("planning", {
      extra: { summary: "Planning" },
      record: false,
    });
    assert.equal(recordCalls, 0);
  });

  it("canWriteRecord false skips record even when record opts present", async () => {
    let recordCalls = 0;
    const { advancePhase } = createRunPhaseController({
      setPhase: () => undefined,
      updateRunRecord: async () => {
        recordCalls += 1;
      },
      persist: async () => undefined,
      canWriteRecord: () => false,
    });

    await advancePhase("freezing", {
      extra: { summary: "Freezing" },
      record: { summary: "Freezing" },
    });
    assert.equal(recordCalls, 0);
  });

  it("propagates record write failures (gate abort semantics)", async () => {
    const { advancePhase } = createRunPhaseController({
      setPhase: () => undefined,
      updateRunRecord: async () => {
        throw new Error("disk full");
      },
      persist: async () => undefined,
      canWriteRecord: () => true,
    });

    await assert.rejects(
      () => advancePhase("awaiting_plan", { record: { summary: "await" } }),
      /disk full/,
    );
  });
});
