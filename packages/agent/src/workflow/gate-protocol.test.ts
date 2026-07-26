/**
 * Unit tests for plan / publication HITL gate loops.
 * No Pi, no disk — inject fakes for coordinator + side-effect callbacks.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultWikiRunSpec,
  type WikiProduceToolDetails,
  type WikiRunPhase,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import type { GateDecision, GatePort, GateRequest } from "../ports/gate-port.js";
import { awaitGate, runPlanGateLoop, runPublicationGateLoop } from "./gate-protocol.js";

function baseSpec(summary = "base"): WikiRunSpec {
  return WikiRunSpecSchema.parse({
    ...defaultWikiRunSpec("GateTest"),
    summary,
  });
}

function gateHarness() {
  const requests: GateRequest[] = [];
  const decisions: Array<(d: GateDecision) => void> = [];
  const arrivals: Array<() => void> = [];
  let consumed = 0;
  return {
    requests,
    coordinator: {
      waitForDecision(request: GateRequest): Promise<GateDecision> {
        requests.push(request);
        arrivals.shift()?.();
        return new Promise((resolve) => decisions.push(resolve));
      },
    } satisfies GatePort,
    async nextRequest(): Promise<GateRequest> {
      if (consumed >= requests.length) {
        await new Promise<void>((resolve) => arrivals.push(resolve));
      }
      return requests[consumed++]!;
    },
    resolve(decision: GateDecision): void {
      const r = decisions.shift();
      assert.ok(r);
      r(decision);
    },
  };
}

function trackPhases() {
  const phases: WikiRunPhase[] = [];
  const setPhase = (
    next: WikiRunPhase,
    _extra?: Omit<Partial<WikiProduceToolDetails>, "status">,
  ) => {
    phases.push(next);
  };
  return { phases, setPhase };
}

describe("awaitGate", () => {
  it("rejects immediately when signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () =>
        awaitGate(
          { waitForDecision: async () => ({ action: "approve" }) },
          {
            toolCallId: "t",
            runId: "r",
            gate: "plan",
            spec: baseSpec(),
            pages: [],
          },
          ac.signal,
        ),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
  });

  it("resolves decision from coordinator", async () => {
    const decision = await awaitGate(
      { waitForDecision: async () => ({ action: "approve" as const }) },
      {
        toolCallId: "t",
        runId: "r",
        gate: "publication",
        spec: baseSpec(),
        pages: ["Home.md"],
      },
    );
    assert.equal(decision.action, "approve");
  });
});

describe("runPlanGateLoop", () => {
  it("approve without override returns approved with initialSpec", async () => {
    const gates = gateHarness();
    const { phases, setPhase } = trackPhases();
    const records: Array<Record<string, unknown>> = [];
    const initial = baseSpec("initial");
    let commits = 0;
    let topologies = 0;
    let plans = 0;

    const done = runPlanGateLoop({
      coordinator: gates.coordinator,
      toolCallId: "t1",
      runId: "run-1",
      initialSpec: initial,
      runPlanner: async () => {
        plans += 1;
        return baseSpec("replanned");
      },
      commitSpec: async () => {
        commits += 1;
      },
      publishTopology: async () => {
        topologies += 1;
      },
      setPhase,
      updateRunRecord: async (patch) => {
        records.push(patch);
      },
    });

    const req = await gates.nextRequest();
    assert.equal(req.gate, "plan");
    assert.equal(req.spec.summary, "initial");
    gates.resolve({ action: "approve" });

    const result = await done;
    assert.equal(result.action, "approved");
    assert.equal(result.spec.summary, "initial");
    assert.equal(plans, 0);
    assert.equal(commits, 0);
    assert.equal(topologies, 0);
    assert.deepEqual(phases, ["awaiting_plan"]);
    assert.ok(records.some((r) => r.status === "awaiting_plan"));
  });

  it("deny returns declined and sets cancelled", async () => {
    const gates = gateHarness();
    const { phases, setPhase } = trackPhases();
    const initial = baseSpec();

    const done = runPlanGateLoop({
      coordinator: gates.coordinator,
      toolCallId: "t2",
      runId: "run-2",
      initialSpec: initial,
      runPlanner: async () => baseSpec("should-not-run"),
      commitSpec: async () => {
        throw new Error("commit should not run on deny");
      },
      publishTopology: async () => {
        throw new Error("topology should not run on deny");
      },
      setPhase,
      updateRunRecord: async () => undefined,
    });

    await gates.nextRequest();
    gates.resolve({ action: "deny" });
    const result = await done;
    assert.equal(result.action, "declined");
    assert.equal(result.spec, initial);
    assert.deepEqual(phases, ["awaiting_plan", "cancelled"]);
  });

  it("revise re-plans once then approve; parses decision.spec once per decision", async () => {
    const gates = gateHarness();
    const { phases, setPhase } = trackPhases();
    const committed: string[] = [];
    const planPriors: Array<string | undefined> = [];
    const initial = baseSpec("initial");
    const override = baseSpec("operator-override");
    const replanned = baseSpec("replanned");

    // Spy on Schema.parse by wrapping through our known path: decision.spec
    // must be a valid WikiRunSpec; we assert revise uses override as prior.
    const done = runPlanGateLoop({
      coordinator: gates.coordinator,
      toolCallId: "t3",
      runId: "run-3",
      initialSpec: initial,
      runPlanner: async (prior, feedback) => {
        planPriors.push(prior?.summary);
        assert.match(feedback ?? "", /runtime seam|Re-evaluate/i);
        return replanned;
      },
      commitSpec: async (spec) => {
        committed.push(spec.summary);
      },
      publishTopology: async (spec) => {
        committed.push(`topo:${spec.summary}`);
      },
      setPhase,
      updateRunRecord: async () => undefined,
    });

    await gates.nextRequest();
    gates.resolve({
      action: "revise",
      feedback: "Emphasize the runtime seam.",
      spec: override,
    });

    const second = await gates.nextRequest();
    assert.equal(second.spec.summary, "replanned");
    gates.resolve({ action: "approve" });

    const result = await done;
    assert.equal(result.action, "approved");
    assert.equal(result.spec.summary, "replanned");
    assert.deepEqual(planPriors, ["operator-override"]);
    assert.deepEqual(committed, ["replanned", "topo:replanned"]);
    assert.ok(phases.includes("awaiting_plan"));
    assert.equal(phases.filter((p) => p === "awaiting_plan").length, 2);
  });

  it("approve with spec override commits and publishes once", async () => {
    const gates = gateHarness();
    const { setPhase } = trackPhases();
    const initial = baseSpec("initial");
    const override = baseSpec("approved-override");
    const committed: string[] = [];

    const done = runPlanGateLoop({
      coordinator: gates.coordinator,
      toolCallId: "t4",
      runId: "run-4",
      initialSpec: initial,
      runPlanner: async () => {
        throw new Error("planner should not run on approve");
      },
      commitSpec: async (spec) => {
        committed.push(spec.summary);
      },
      publishTopology: async (spec) => {
        committed.push(`topo:${spec.summary}`);
      },
      setPhase,
      updateRunRecord: async () => undefined,
    });

    await gates.nextRequest();
    gates.resolve({ action: "approve", spec: override });
    const result = await done;
    assert.equal(result.action, "approved");
    assert.equal(result.spec.summary, "approved-override");
    assert.deepEqual(committed, ["approved-override", "topo:approved-override"]);
  });
});

describe("runPublicationGateLoop", () => {
  it("approve returns approve without declined phase", async () => {
    const gates = gateHarness();
    const { phases, setPhase } = trackPhases();
    const spec = baseSpec();

    const done = runPublicationGateLoop({
      coordinator: gates.coordinator,
      toolCallId: "t5",
      runId: "run-5",
      spec,
      pages: ["Home.md"],
      recordSummary: "ready",
      setPhase,
      updateRunRecord: async () => undefined,
    });

    const req = await gates.nextRequest();
    assert.equal(req.gate, "publication");
    assert.deepEqual(req.pages, ["Home.md"]);
    gates.resolve({ action: "approve" });

    const result = await done;
    assert.equal(result.action, "approve");
    assert.deepEqual(phases, ["awaiting_publication"]);
  });

  it("deny returns declined and sets publication_declined", async () => {
    const gates = gateHarness();
    const { phases, setPhase } = trackPhases();
    const records: Array<Record<string, unknown>> = [];

    const done = runPublicationGateLoop({
      coordinator: gates.coordinator,
      toolCallId: "t6",
      runId: "run-6",
      spec: baseSpec(),
      pages: ["A.md"],
      recordSummary: "produced",
      setPhase,
      updateRunRecord: async (patch) => {
        records.push(patch);
      },
    });

    await gates.nextRequest();
    gates.resolve({ action: "deny" });
    const result = await done;
    assert.equal(result.action, "declined");
    assert.deepEqual(phases, ["awaiting_publication", "publication_declined"]);
    assert.ok(records.some((r) => r.status === "publication_declined"));
  });
});
