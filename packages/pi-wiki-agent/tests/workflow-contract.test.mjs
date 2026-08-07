import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowScript } from "@quintinshaw/pi-dynamic-workflows";
import { WIKI_WORKFLOW_SCRIPT } from "../dist/wiki-workflow.js";
import { WIKI_RUNTIME_DEFINITION } from "../dist/runtime.js";

test("workflow uses host tools, publishes all required graph edges, and never invokes CLI shell", () => {
  assert.equal(parseWorkflowScript(WIKI_WORKFLOW_SCRIPT).meta.name, "wiki");
  for (const name of ["okf_prepare", "okf_survey_merge", "okf_publish", "okf_validate"]) {
    assert.match(WIKI_WORKFLOW_SCRIPT, new RegExp(name));
  }
  assert.doesNotMatch(WIKI_WORKFLOW_SCRIPT, /okf_plan_gate/);
  assert.match(WIKI_WORKFLOW_SCRIPT, /"write-sources"/);
  assert.match(WIKI_WORKFLOW_SCRIPT, /publish\(runId, "validate"/);
  assert.match(WIKI_WORKFLOW_SCRIPT, /merged\.artifactsPath/);
  assert.match(WIKI_WORKFLOW_SCRIPT, /discovery-labels-pass-/);
  assert.match(WIKI_WORKFLOW_SCRIPT, /review-artifacts-round-/);
  assert.match(WIKI_WORKFLOW_SCRIPT, /repair-artifacts-round-/);
  assert.match(WIKI_WORKFLOW_SCRIPT, /analysis\/defects\.json/);
  assert.doesNotMatch(WIKI_WORKFLOW_SCRIPT, /\bhostCli\b|\bow\s+(?:prepare|publish|gate|validate)/);
});

test("runtime binding uses a stable Pi extension identity and SHA-256 workflow digest", () => {
  assert.equal(WIKI_RUNTIME_DEFINITION.kind, "pi");
  assert.equal(WIKI_RUNTIME_DEFINITION.extension, "@okf-wiki/pi-wiki-agent");
  assert.match(WIKI_RUNTIME_DEFINITION.workflow.digest, /^sha256:[a-f0-9]{64}$/);
});
