import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  effectiveSourceIgnores,
  pathMatchesIgnore,
  loadDefaultIgnores,
} from "../scripts/lib/ignores.mjs";

describe("ignores", () => {
  it("defaults include java build noise", () => {
    const d = loadDefaultIgnores();
    assert.ok(d.includes("target/**"));
    assert.ok(d.includes("*.class"));
    assert.ok(d.includes(".gradle/**"));
  });

  it("defaults exclude Pi and Wiki runtime output for same-directory sources", () => {
    const d = loadDefaultIgnores();
    assert.ok(d.includes(".wiki-agent/**"));
    assert.ok(d.includes(".pi/**"));
    assert.ok(d.includes(".claude/**"));
    assert.equal(pathMatchesIgnore(".wiki-agent/runs/a/workdir/inputs/inventory.json", d), true);
    assert.equal(pathMatchesIgnore(".pi/sessions/current.json", d), true);
    assert.equal(pathMatchesIgnore(".claude/workflows/wiki.workflow.js", d), true);
  });

  it("effective unions defaults + presets + user", () => {
    const eff = effectiveSourceIgnores({
      applyDefaultIgnores: true,
      presets: ["java-tests"],
      ignore: ["**/custom/**"],
    });
    assert.ok(eff.includes("target/**"));
    assert.ok(eff.includes("src/test/**"));
    assert.ok(eff.includes("**/custom/**"));
  });

  it("disabling defaults drops catalog but keeps user", () => {
    const eff = effectiveSourceIgnores({
      applyDefaultIgnores: false,
      ignore: ["foo/**"],
    });
    assert.ok(!eff.includes("target/**"));
    assert.deepEqual(eff, ["foo/**"]);
  });

  it("pathMatchesIgnore hides target and class files", () => {
    const patterns = effectiveSourceIgnores({ applyDefaultIgnores: true });
    assert.equal(pathMatchesIgnore("target/classes/Foo.class", patterns), true);
    assert.equal(pathMatchesIgnore("src/main/java/Foo.java", patterns), false);
    assert.equal(pathMatchesIgnore("node_modules/x/index.js", patterns), true);
  });

  it("basename-only globs match nested paths (*.class → pkg/Foo.class)", () => {
    const patterns = ["*.class"];
    assert.equal(pathMatchesIgnore("Foo.class", patterns), true);
    assert.equal(pathMatchesIgnore("pkg/Foo.class", patterns), true);
    assert.equal(pathMatchesIgnore("a/b/c/Bar.class", patterns), true);
    assert.equal(pathMatchesIgnore("pkg/Foo.java", patterns), false);
  });
});
