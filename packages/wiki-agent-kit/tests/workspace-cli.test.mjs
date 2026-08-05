import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OW = path.resolve(__dirname, "../scripts/ow.mjs");

function ow(args, cwd) {
  return spawnSync(process.execPath, [OW, ...args], {
    cwd,
    encoding: "utf8",
  });
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
    assert.ok(fs.existsSync(path.join(ws, "workspace.json")));

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
    assert.equal(frozen.workflow.command, "/wiki-plan");
    assert.equal(frozen.workflow.args.runId, frozen.runId);
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

    r = ow(["plan", "--run", frozen.runId, "--workspace", ws], tmp);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stderr, /unknown command: plan/i);

    const linked = path.join(ws, "sources", "api");
    const lstat = fs.lstatSync(linked);
    assert.ok(lstat.isSymbolicLink() || lstat.isDirectory());
    assert.equal(fs.realpathSync(linked), fs.realpathSync(repo));
    const workspace = JSON.parse(fs.readFileSync(path.join(ws, "workspace.json"), "utf8"));
    const src = workspace.sources.find((s) => s.id === "api");
    assert.equal(src.origin.type, "path");
    assert.equal(src.origin.linkType, process.platform === "win32" ? "junction" : "dir");
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

    r = ow(["gate", "plan", "--run", frozen.runId, "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const gated = JSON.parse(r.stdout);
    assert.ok(gated.receipt);
    assert.equal(gated.workflow.command, "/wiki-write-review");
    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(JSON.parse(r.stdout).runs[0].status, "write-ready");

    r = ow(["validate", "--run", frozen.runId, "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const validated = JSON.parse(r.stdout);
    assert.equal(validated.ok, true);
    assert.ok(validated.manifest.candidateDigest);
    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(JSON.parse(r.stdout).runs[0].status, "sealed");

    r = ow(["validate", "--run", frozen.runId, "--workspace", ws], tmp);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stderr, /candidate is already sealed/);

    fs.appendFileSync(path.join(workdir, "candidate", "overview.md"), "tampered\n");
    r = ow(["status", "--workspace", ws], tmp);
    assert.equal(JSON.parse(r.stdout).runs[0].status, "tampered");

    const beforeRetry = fs.readFileSync(path.join(ws, ".wiki-agent", "runs", frozen.runId, "meta.json"), "utf8");
    r = ow(["retry", "--run", frozen.runId, "--from", "write", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(fs.existsSync(path.join(workdir, "analysis", "spec.json")));
    assert.deepEqual(fs.readdirSync(path.join(workdir, "candidate")), []);
    assert.equal(fs.readFileSync(path.join(ws, ".wiki-agent", "runs", frozen.runId, "meta.json"), "utf8"), beforeRetry);
  });
});
