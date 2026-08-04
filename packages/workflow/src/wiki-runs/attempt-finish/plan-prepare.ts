/**
 * After plan Spec is sealed, compile ExecutionPlan (fail-closed on fan-out caps
 * and coverage gaps when a CoveragePlan is sealed) and prepare it as an unsealed
 * artifact for seal+commit.
 * Called from the scheduler before commitSuccessfulAttempt.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  planUncertaintyFromSpec,
  resolveAdaptiveOrchestration,
  WikiRunSpecSchema,
} from "@okf-wiki/contract/wiki-runs";
import { runWorkDir, toAdaptiveRepositoryInventory } from "@okf-wiki/core";
import { compileExecutionPlan } from "../../plan-compiler.js";
import { prepareUnsealedArtifact } from "../artifacts.js";
import {
  loadSealedContractCoveragePlan,
  loadSealedCoverageInventory,
} from "../coverage-bridge.js";
import type { WikiRunsCasCtx } from "../ctx.js";
import type { ArtifactPreparation, ClaimedNode } from "../types.js";

export async function preparePlanExecutionPlan(
  host: WikiRunsCasCtx,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
): Promise<ArtifactPreparation | undefined> {
  if (claim.kind !== "plan") return undefined;
  if (preparations.some((p) => p.role === "execution_plan" || p.kind === "execution_plan")) {
    return undefined; // already present
  }
  const specPrep = preparations.find((item) => item.role === "spec" || item.kind === "spec");
  if (!specPrep) throw new Error("plan attempt succeeded without a Spec artifact");

  const runDir = runWorkDir(host.workspace.rootPath, claim.runId);
  const spec = loadSpecJson(path.join(runDir, specPrep.relativePath));
  if (!spec) throw new Error("plan Spec artifact is not parseable");

  // Phase 7: adaptive lenses from inventory + Spec uncertainty (default 1).
  const workspace = host.workspaceForRun(claim.runId);
  const sealedInventory = loadSealedCoverageInventory(host.db, claim.runId, runDir);
  // multiEntry is an inventory walk signal (multi-package monorepo) — never
  // implied by multi-source alone (sourceCount). Without sealed inventory we
  // only know sourceCount; omit multiEntry/large so adaptive-router treats them false.
  const inventory = sealedInventory
    ? toAdaptiveRepositoryInventory(sealedInventory)
    : {
        sourceCount: workspace.sources?.length ?? 0,
      };
  const planUncertainty = planUncertaintyFromSpec(spec);
  const adaptive = resolveAdaptiveOrchestration({
    orchestration: workspace.orchestration,
    inventory,
    planUncertainty,
  });
  const orch = adaptive.orchestration;
  // plan.adapt is DEFAULT-OFF (ADR / plan-compiler). Do not force on merely
  // leaving light path — only high Spec uncertainty. 0.5 ≈ saturated openQuestions
  // in planUncertaintyFromSpec (6+ OQs) without requiring multi-domain fan-out.
  const HIGH_PLAN_UNCERTAINTY = 0.5;
  const adaptationRequired = planUncertainty >= HIGH_PLAN_UNCERTAINTY;
  const coveragePlan = loadSealedContractCoveragePlan(host.db, claim.runId, runDir);
  const plan = compileExecutionPlan(spec, {
    maxDomainFanOut: orch.maxDomainFanOut,
    maxLeafFanOut: orch.maxLeafFanOut,
    reviewCouncilSize: orch.reviewCouncilSize,
    adaptationRequired,
    specDigest: specPrep.digest,
    ...(coveragePlan ? { coveragePlan } : {}),
  });

  const stageParent = path.join(runDir, "attempts", claim.attemptId, "work");
  await mkdir(stageParent, { recursive: true });
  const planPath = path.join(stageParent, "execution-plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  return prepareUnsealedArtifact(host, claim, {
    kind: "execution_plan",
    role: "execution_plan",
    sourcePath: planPath,
    directory: false,
  });
}

/** Load WikiRunSpec JSON from the canonical sealed Spec payload. */
function loadSpecJson(
  artifactRoot: string,
): ReturnType<typeof WikiRunSpecSchema.parse> | undefined {
  try {
    const raw = readFileSync(path.join(artifactRoot, "spec.json"), "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
