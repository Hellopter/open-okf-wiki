import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OW = path.resolve(__dirname, "../scripts/ow.mjs");

function ow(args, cwd) {
  return spawnSync(process.execPath, [OW, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function readWorkspace(ws) {
  const yamlPath = path.join(ws, "workspace.yaml");
  const ymlPath = path.join(ws, "workspace.yml");
  const jsonPath = path.join(ws, "workspace.json");
  if (fs.existsSync(yamlPath)) return YAML.parse(fs.readFileSync(yamlPath, "utf8"));
  if (fs.existsSync(ymlPath)) return YAML.parse(fs.readFileSync(ymlPath, "utf8"));
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

describe("ow init + source path + freeze", () => {
  it("creates workspace, adds path source, freezes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-test-"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "src", "main", "java"), { recursive: true });
    fs.writeFileSync(path.join(repo, "pom.xml"), "<project/>\n");
    fs.writeFileSync(
      path.join(repo, "src", "main", "java", "App.java"),
      "class App {}\n",
    );
    fs.mkdirSync(path.join(repo, "target"), { recursive: true });
    fs.writeFileSync(path.join(repo, "target", "x.class"), "xx");

    const ws = path.join(tmp, "ws");
    let r = ow(["init", ws, "--name", "demo", "--lang", "zh", "--path", repo, "--id", "api"], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const initOut = JSON.parse(r.stdout);
    assert.equal(initOut.wikiLanguage, "zh");
    assert.equal(initOut.format, "yaml");
    assert.ok(initOut.workspace.endsWith("workspace.yaml"));
    assert.ok(fs.existsSync(path.join(ws, "workspace.yaml")));
    assert.ok(!fs.existsSync(path.join(ws, "workspace.json")));

    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(r.stdout);
    assert.equal(st.sources.length, 1);
    assert.equal(st.wikiLanguage, "zh");

    r = ow(["doctor", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const doctor = JSON.parse(r.stdout);
    assert.equal(doctor.assets.ok, true);
    assert.equal(doctor.dynamicWorkflowPrerequisite.required, true);
    assert.ok(Object.hasOwn(doctor.claude, "versionSupported"));

    r = ow(["freeze", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const frozen = JSON.parse(r.stdout);
    assert.ok(frozen.runId);
    assert.equal(frozen.workflow.command, "/wiki-produce");
    assert.equal(frozen.workflow.args.runId, frozen.runId);
    assert.ok(fs.existsSync(path.join(ws, ".wiki-agent", "current.json")));
    assert.ok(fs.existsSync(path.join(ws, ".wiki-agent", "next-action.json")));
    const current = JSON.parse(fs.readFileSync(path.join(ws, ".wiki-agent", "current.json"), "utf8"));
    assert.equal(current.runId, frozen.runId);
    assert.equal(current.command, "/wiki-produce");
    const workdir = frozen.workdir;
    assert.ok(fs.existsSync(path.join(workdir, "inputs", "inventory.json")));
    assert.ok(fs.existsSync(path.join(workdir, "inputs", "snapshot-manifest.json")));
    assert.ok(fs.existsSync(path.join(workdir, "candidate")));
    assert.ok(fs.existsSync(path.join(workdir, "sources", "api", "src", "main", "java", "App.java")));
    assert.ok(!fs.existsSync(path.join(workdir, "sources", "api", "target", "x.class")));
    assert.ok(fs.existsSync(path.join(ws, ".agents", "skills", "repository-wiki-producer", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(ws, ".claude", "skills", "repository-wiki-producer", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(ws, ".claude", "workflows", "wiki-plan.workflow.js")));
    assert.ok(fs.existsSync(path.join(ws, ".claude", "workflows", "wiki-write-review.workflow.js")));
    assert.ok(fs.existsSync(path.join(ws, ".claude", "workflows", "wiki-produce.workflow.js")));

    const policy = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "run-policy.json"), "utf8"));
    assert.equal(policy.wikiLanguage, "zh");
    const inventory = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "inventory.json"), "utf8"));
    assert.equal(inventory.wikiLanguage, "zh");

    // gate without spec should fail closed when units exist
    r = ow(["gate", "plan", "--run", frozen.runId, "--workspace", ws], tmp);
    assert.equal(r.status, 2, r.stderr || r.stdout);
    const gate = JSON.parse(r.stdout);
    assert.equal(gate.ok, false);
    assert.ok(
      gate.errors.some((e) => /missing spec|cannot assert coverage/i.test(e)),
      JSON.stringify(gate.errors),
    );
    assert.ok(
      !fs.existsSync(path.join(workdir, "inputs", "gate-plan.ok.json")),
      "must not write gate-plan.ok.json on failure",
    );

    fs.appendFileSync(
      path.join(ws, ".agents", "skills", "repository-wiki-producer", "SKILL.md"),
      "\nlocal drift\n",
    );
    r = ow(["freeze", "--workspace", ws], tmp);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stderr, /installed skill drifted.*ow install --force/i);

    r = ow(["run", "--resume", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const resumed = JSON.parse(r.stdout);
    assert.equal(resumed.mode, "resume");
    assert.equal(resumed.runId, frozen.runId);
    assert.equal(resumed.workflow.command, "/wiki-produce");

    const linked = path.join(ws, "sources", "api");
    const lstat = fs.lstatSync(linked);
    assert.ok(lstat.isSymbolicLink() || lstat.isDirectory());
    assert.equal(fs.realpathSync(linked), fs.realpathSync(repo));
    const workspace = readWorkspace(ws);
    const src = workspace.sources.find((s) => s.id === "api");
    assert.equal(src.origin.type, "path");
    assert.equal(src.origin.linkType, process.platform === "win32" ? "junction" : "dir");
  });

  it("supports --format json and loads legacy workspace.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-json-ws-"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "A.js"), "export const x = 1;\n");
    const ws = path.join(tmp, "ws");

    let r = ow(["init", ws, "--name", "json-demo", "--format", "json", "--path", repo, "--id", "app"], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const initOut = JSON.parse(r.stdout);
    assert.equal(initOut.format, "json");
    assert.ok(fs.existsSync(path.join(ws, "workspace.json")));
    assert.ok(!fs.existsSync(path.join(ws, "workspace.yaml")));

    r = ow(["config", "set", "wikiLanguage", "zh", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const after = JSON.parse(fs.readFileSync(path.join(ws, "workspace.json"), "utf8"));
    assert.equal(after.wikiLanguage, "zh");

    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(r.stdout).wikiLanguage, "zh");
  });

  it("rejects multiple workspace config files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-multi-cfg-"));
    const ws = path.join(tmp, "ws");
    let r = ow(["init", ws, "--name", "multi"], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    fs.writeFileSync(path.join(ws, "workspace.json"), JSON.stringify({ version: 1, sources: [] }));
    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stderr, /multiple workspace configs/i);
  });

  it("runs the full gated lifecycle and seals a local-link candidate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-lifecycle-"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), "{\"name\":\"demo\"}\n");
    fs.writeFileSync(path.join(repo, "src", "A.js"), "export const answer = 42;\n");
    const ws = path.join(tmp, "ws");

    let r = ow(["init", ws, "--name", "demo", "--path", repo, "--id", "app"], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    r = ow(["freeze", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const frozen = JSON.parse(r.stdout);
    const workdir = frozen.workdir;
    fs.writeFileSync(
      path.join(workdir, "analysis", "discovery-map.json"),
      JSON.stringify({
        domains: [{ id: "domain:app", coverageUnitIds: ["app"] }],
        flows: [],
        coverageUnits: [{ id: "app", required: true }],
      }),
    );
    fs.writeFileSync(
      path.join(workdir, "analysis", "spec.json"),
      JSON.stringify({
        version: 1,
        pages: [{ path: "overview.md", critical: true, coverageUnitIds: ["app"] }],
      }),
    );

    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(JSON.parse(r.stdout).runs[0].status, "planned");

    fs.writeFileSync(
      path.join(workdir, "candidate", "overview.md"),
      [
        "---",
        "type: Overview",
        "title: Demo",
        "description: A small demo.",
        "---",
        "",
        "[Source: src/A.js L1](../sources/app/src/A.js#L1)",
        "",
      ].join("\n"),
    );
    r = ow(["validate", "--run", frozen.runId, "--workspace", ws], tmp);
    assert.equal(r.status, 2, r.stderr || r.stdout);
    assert.match(JSON.stringify(JSON.parse(r.stdout)), /plan gate receipt/i);

    r = ow(["gate", "plan", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const gated = JSON.parse(r.stdout);
    assert.ok(gated.receipt);
    assert.equal(gated.workflow.command, "/wiki-write-review");
    assert.equal(gated.nextAction.command, "/wiki-write-review");
    r = ow(["status", "--workspace", ws], tmp);
    const statusAfterGate = JSON.parse(r.stdout);
    assert.equal(statusAfterGate.runs[0].status, "write-ready");
    assert.equal(statusAfterGate.current.command, "/wiki-write-review");
    assert.equal(statusAfterGate.active.runId, frozen.runId);

    r = ow(["validate", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const validated = JSON.parse(r.stdout);
    assert.equal(validated.ok, true);
    assert.ok(validated.manifest.candidateDigest);
    assert.equal(validated.nextAction.command, "done");
    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(JSON.parse(r.stdout).runs[0].status, "sealed");

    r = ow(["validate", "--run", frozen.runId, "--workspace", ws], tmp);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stderr, /candidate is already sealed/);

    fs.appendFileSync(path.join(workdir, "candidate", "overview.md"), "tampered\n");
    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(JSON.parse(r.stdout).runs[0].status, "tampered");

    const beforeRetry = fs.readFileSync(path.join(ws, ".wiki-agent", "runs", frozen.runId, "meta.json"), "utf8");
    r = ow(["retry", "--from", "write", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const retried = JSON.parse(r.stdout);
    assert.equal(retried.nextAction.command, "/wiki-write-review");
    assert.ok(fs.existsSync(path.join(workdir, "analysis", "spec.json")));
    assert.deepEqual(fs.readdirSync(path.join(workdir, "candidate")), []);
    assert.equal(fs.readFileSync(path.join(ws, ".wiki-agent", "runs", frozen.runId, "meta.json"), "utf8"), beforeRetry);

    r = ow(["run", "--approve-plan", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const approvedMode = JSON.parse(r.stdout);
    assert.equal(approvedMode.workflow.command, "/wiki-plan");
    assert.equal(approvedMode.nextAction.approvePlan, true);
  });
});
