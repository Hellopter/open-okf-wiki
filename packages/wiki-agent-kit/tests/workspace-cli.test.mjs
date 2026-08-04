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

    r = ow(["produce", "--prepare", "--workspace", ws], tmp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const prod = JSON.parse(r.stdout);
    assert.ok(prod.runId);
    const workdir = prod.workdir;
    assert.ok(fs.existsSync(path.join(workdir, "inputs", "inventory.json")));
    assert.ok(fs.existsSync(path.join(workdir, "sources", "api", "src", "main", "java", "App.java")));
    assert.ok(!fs.existsSync(path.join(workdir, "sources", "api", "target", "x.class")));

    // gate without spec should fail closed when units exist
    r = ow(["gate", "plan", "--run", prod.runId, "--workspace", ws], tmp);
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
  });
});
