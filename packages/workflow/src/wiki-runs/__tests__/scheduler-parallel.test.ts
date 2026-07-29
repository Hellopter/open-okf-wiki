/**
 * Scheduler must run independent ready leaves in parallel under domainConcurrency.
 * Serial await (pre-fix) made multi-domain leaf work sequential and ignored Settings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkspace, saveWorkspace } from "@okf-wiki/core";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  approvePlanGate,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
} from "./harness.js";

test("independent research.leaf nodes run concurrently under domainConcurrency", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  // domainConcurrency=2 → leaf pool = 2 * min(2, maxLeafFanOut) = 4 slots.
  const workspace = await loadWorkspace(root);
  assert.ok(workspace);
  workspace.orchestration = {
    ...workspace.orchestration,
    domainConcurrency: 2,
    maxLeafFanOut: 6,
    maxDomainFanOut: 4,
  };
  await saveWorkspace(workspace);

  let maxConcurrentLeaves = 0;
  let inflightLeaves = 0;
  const releaseGates = new Map<string, () => void>();

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") {
        // Two domains × two leaves each so four leaves become ready together.
        const spec = {
          summary: "Parallel leaf fixture",
          audience: "testers",
          domains: [
            {
              id: "alpha",
              title: "Alpha",
              scope: "alpha",
              critical: true,
              questions: ["a1?", "a2?"],
            },
            {
              id: "beta",
              title: "Beta",
              scope: "beta",
              critical: false,
              questions: ["b1?", "b2?"],
            },
          ],
          pages: [
            {
              path: "overview.md",
              purpose: "Overview",
              domainIds: ["alpha", "beta"],
              template: "overview" as const,
            },
          ],
          acceptance: { mustCover: [], mustCite: [] },
        };
        const { writeFile, mkdir } = await import("node:fs/promises");
        const path = await import("node:path");
        const specPath = path.join(input.workDir, "spec.json");
        await mkdir(input.workDir, { recursive: true });
        await writeFile(specPath, `${JSON.stringify(spec)}\n`, "utf8");
        const planOut = await succeededPlan(input, "Parallel leaf fixture");
        // Replace default single-domain Spec with multi-domain.
        await writeFile(specPath, `${JSON.stringify(spec)}\n`, "utf8");
        if (planOut.type !== "succeeded") return planOut;
        return {
          ...planOut,
          unsealedArtifacts: planOut.unsealedArtifacts.map((a) =>
            a.kind === "spec" ? { ...a, sourcePath: specPath } : a,
          ),
        };
      }

      if (input.node.kind === "research.leaf") {
        inflightLeaves += 1;
        maxConcurrentLeaves = Math.max(maxConcurrentLeaves, inflightLeaves);
        try {
          // Hold every leaf until we have seen parallel fan-out, then release all.
          await new Promise<void>((resolve) => {
            releaseGates.set(input.node.key, resolve);
            if (inflightLeaves >= 2) {
              for (const release of releaseGates.values()) release();
              releaseGates.clear();
            }
            // Safety: never hang the suite if only one leaf is claimed.
            setTimeout(() => {
              resolve();
              for (const release of releaseGates.values()) release();
              releaseGates.clear();
            }, 2_000);
          });
          return fullGraphFixtureExecutor(input, signal);
        } finally {
          inflightLeaves -= 1;
        }
      }

      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-parallel-leaves" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-parallel-leaves");

  // Wait until all four leaves succeed.
  for (let count = 0; count < 500; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaves = snapshot.nodes.filter((n) => n.kind === "research.leaf");
    if (leaves.length >= 4 && leaves.every((n) => n.state === "succeeded")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  const leaves = after.nodes.filter((n) => n.kind === "research.leaf");
  assert.equal(leaves.length, 4, "expected four research.leaf nodes from two domains");
  assert.ok(
    leaves.every((n) => n.state === "succeeded"),
    `leaves should succeed: ${leaves.map((n) => `${n.key}=${n.state}`).join(",")}`,
  );
  assert.ok(
    maxConcurrentLeaves >= 2,
    `expected ≥2 concurrent leaves (got ${maxConcurrentLeaves}) — scheduler must not serial-await`,
  );
});
