import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanScoutTask } from "@okf-wiki/contract/wiki-runs";
import type { RunWorkdirLayout } from "../runtime/workdir.js";
import { plannerPrompt } from "./plan.js";
import { planScoutPrompt } from "./plan-scout.js";

const layout: RunWorkdirLayout = {
  runWorkDir: "/run",
  sourcesDir: "/run/sources",
  skillDir: "/run/skill",
  wikiDir: "/run/wiki",
  analysisDir: "/run/analysis",
  sourceMounts: new Map([["main", "/run/sources/main"]]),
};

describe("planner prompt", () => {
  it("includes operator notes in the initial planning request", () => {
    const prompt = plannerPrompt({
      layout,
      workspaceName: "Demo",
      operatorNotes: "Focus on the runtime boundary.",
    });

    assert.match(prompt, /Operator-requested focus:\nFocus on the runtime boundary\./);
  });

  it("requires submit_wiki_run_spec path-first handoff", () => {
    const prompt = plannerPrompt({ layout, workspaceName: "Demo" });
    assert.match(prompt, /submit_wiki_run_spec/);
    assert.match(prompt, /plan-draft\.json/);
    assert.match(prompt, /never Spec authority|Chat is never Spec|not.*primary delivery/i);
  });

  it("is DiscoveryMap-first and mentions dual gates", () => {
    const prompt = plannerPrompt({
      layout,
      workspaceName: "Demo",
      discoveryMapPath: "inputs/discovery-map.json",
    });
    assert.match(prompt, /DiscoveryMap-first|discovery-map\.json/);
    assert.match(prompt, /assertCoverage/);
    assert.match(prompt, /assertSemanticSufficiency/);
  });

  it("includes fan-out cap numbers when provided", () => {
    const prompt = plannerPrompt({
      layout,
      workspaceName: "Demo",
      maxDomainFanOut: 4,
      maxLeafFanOut: 6,
    });
    assert.match(prompt, /At most 4 domain/);
    assert.match(prompt, /maxDomainFanOut/);
    assert.match(prompt, /At most 6 question/);
    assert.match(prompt, /maxLeafFanOut/);
  });

  it("includes multi-source and required unit rules when sourceCount >= 2", () => {
    const multiLayout: RunWorkdirLayout = {
      ...layout,
      sourceMounts: new Map([
        ["api", "/run/sources/api"],
        ["web", "/run/sources/web"],
      ]),
    };
    const prompt = plannerPrompt({
      layout: multiLayout,
      workspaceName: "Demo",
      sourceCount: 2,
      requiredUnitIds: ["api", "web"],
    });
    assert.match(prompt, /Multi-source freeze/);
    assert.match(prompt, /required coverage units/i);
    assert.match(prompt, /- api/);
    assert.match(prompt, /- web/);
    assert.match(prompt, /coverageUnitIds/);
  });
});

describe("plan scout prompts (source-qualified semantic)", () => {
  it("domain:{sourceId} stays under that source and caps candidates", () => {
    const task: PlanScoutTask = {
      kind: "domain",
      id: "domain:api",
      sourceId: "api",
      required: true,
    };
    const prompt = planScoutPrompt({ task, workspaceName: "Demo" });
    assert.match(prompt, /sources\/api\//);
    assert.match(prompt, /Do not survey other sources/);
    assert.match(prompt, /at most 5 domain|≤5/i);
    assert.match(prompt, /≥3 non-README|non-README evidence/i);
    assert.match(prompt, /coverageUnitIds \(include "api"\)/);
    assert.match(prompt, /Sealed analysis\/plan-scouts\/\* is the durable authority/);
  });

  it("flow:{sourceId} traces in-source critical paths only", () => {
    const task: PlanScoutTask = {
      kind: "flow",
      id: "flow:web",
      sourceId: "web",
      required: true,
    };
    const prompt = planScoutPrompt({ task, workspaceName: "Demo" });
    assert.match(prompt, /sources\/web\//);
    assert.match(prompt, /crossSource: false/);
    assert.match(prompt, /flow:cross/);
    assert.doesNotMatch(prompt, /CROSS-SOURCE FLOWS \(flow:cross\)/);
  });

  it("flow:cross targets multi-source contracts only", () => {
    const task: PlanScoutTask = {
      kind: "flow",
      id: "flow:cross",
      sourceId: "cross",
      cross: true,
      required: true,
    };
    const prompt = planScoutPrompt({ task, workspaceName: "Demo" });
    assert.match(prompt, /CROSS-SOURCE FLOWS \(flow:cross\)/);
    assert.match(prompt, /crossSource: true/);
    assert.match(prompt, /at least two sources/i);
    assert.match(prompt, /HTTP\/RPC|events|queues|auth/i);
  });

  it("concept:{sourceId} prefers that source mount", () => {
    const task: PlanScoutTask = {
      kind: "concept",
      id: "concept:api",
      sourceId: "api",
      required: false,
    };
    const prompt = planScoutPrompt({ task, workspaceName: "Demo" });
    assert.match(prompt, /sources\/api\//);
    assert.match(prompt, /Candidate concepts/);
    assert.match(prompt, /not glossary fluff/);
  });

  it("legacy bare semantic remains global", () => {
    const task: PlanScoutTask = {
      kind: "domain",
      id: "domain",
      required: true,
    };
    const prompt = planScoutPrompt({ task, workspaceName: "Demo" });
    assert.match(prompt, /global \/ legacy/i);
    assert.match(prompt, /sources\//);
  });
});

