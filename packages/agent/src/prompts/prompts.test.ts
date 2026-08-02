import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunWorkdirLayout } from "../runtime/workdir.js";
import { plannerPrompt } from "./plan.js";

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
});
