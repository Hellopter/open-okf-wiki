import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { defaultWikiRunSpec, type PiAttemptInput, type PiAttemptOutcome } from "@okf-wiki/contract";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  approvePlanGate,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
  waitForRunState,
} from "./harness.js";

async function deltaOutcome(input: PiAttemptInput, delta: unknown): Promise<PiAttemptOutcome> {
  const analysis = path.join(input.workDir, "analysis");
  await mkdir(analysis, { recursive: true });
  const deltaPath = path.join(analysis, "execution-plan-delta.json");
  await writeFile(deltaPath, `${JSON.stringify(delta)}\n`, "utf8");
  const transcript = path.join(input.attemptDir, "session.jsonl");
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(
    transcript,
    `${JSON.stringify({ role: "assistant", content: "adapt" })}\n`,
    "utf8",
  );
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "plan_delta", sourcePath: deltaPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: "research gap found",
  };
}

test("plan.adapt derives bounded research edges before writer unlocks", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "plan") {
        const spec = defaultWikiRunSpec("Workflow test");
        spec.openQuestions = [
          "Which authorization boundaries remain uncertain?",
          "Which module owns authentication?",
          "Which callers enforce authorization?",
          "How do authorization failures surface?",
          "Which tests cover boundary decisions?",
          "Which documentation explains the boundary?",
        ];
        return succeededPlan(input, "Workflow test", spec);
      }
      if (input.node.key === "plan.adapt.1") {
        return deltaOutcome(input, {
          version: 1,
          complete: false,
          additions: [
            {
              id: "core-auth-gap",
              domainId: "core",
              question: "Which module establishes authorization boundaries?",
              scope: "Trace authorization checks across the core module.",
            },
          ],
          reason: "Initial receipts leave an authorization boundary unresolved.",
        });
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "adapt-start", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "adapt-approve");
  const atPublication = await waitForRunState(
    runs,
    receipt.runId,
    ["waiting_for_operator"],
    60_000,
  );
  const snapshot = atPublication.snapshot;
  const leaf = snapshot.nodes.find((node) => node.key === "research.leaf.core.adapt.1.1");
  assert.equal(leaf?.state, "succeeded");
  assert.equal(leaf?.detail?.workUnitId, "core-auth-gap");
  assert.equal(snapshot.nodes.find((node) => node.key === "plan.adapt.2")?.state, "succeeded");
  assert.ok(
    snapshot.edges.some(
      (edge) => edge.from === "plan.adapt.1" && edge.to === "research.leaf.core.adapt.1.1",
    ),
  );
  assert.ok(
    snapshot.edges.some(
      (edge) => edge.from === "research.leaf.core.adapt.1.1" && edge.to === "plan.adapt.2",
    ),
  );
  assert.ok(
    snapshot.edges.some(
      (edge) => edge.from === "research.leaf.core.adapt.1.1" && edge.to === "write.root",
    ),
  );
});
