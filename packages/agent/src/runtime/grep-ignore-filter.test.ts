import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  filterGrepContentText,
  grepResultPath,
  type GrepIgnoreFilterContext,
} from "./grep-ignore-filter.js";

const runWorkDir = path.resolve("/tmp/okf-wiki-run-workdir");
const resultBase = path.join(runWorkDir, "sources", "repo");

function ctx(sourceIgnores: GrepIgnoreFilterContext["sourceIgnores"]): GrepIgnoreFilterContext {
  return { runWorkDir, resultBase, sourceIgnores };
}

describe("grepResultPath", () => {
  it("parses match and context line prefixes", () => {
    assert.equal(grepResultPath("src/main.ts:12:const x = 1"), "src/main.ts");
    assert.equal(grepResultPath("src/main.ts-12-context"), "src/main.ts");
    assert.equal(grepResultPath("No matches found"), undefined);
    assert.equal(grepResultPath("--"), undefined);
  });
});

describe("filterGrepContentText", () => {
  const ignores = new Map<string, readonly string[]>([["repo", ["ignored/**"]]]);

  it("drops ignored path match lines and keeps visible matches", () => {
    const text = [
      "visible.ts:1:export const ok = true;",
      "ignored/secret.ts:1:secret",
      "src/app.ts:3:secret value",
    ].join("\n");
    const filtered = filterGrepContentText(text, ctx(ignores));
    assert.match(filtered, /visible\.ts/);
    assert.match(filtered, /src\/app\.ts/);
    assert.doesNotMatch(filtered, /ignored\/secret\.ts/);
  });

  it("keeps lines without a path prefix", () => {
    const text = ["--", "visible.ts:1:ok", ""].join("\n");
    const filtered = filterGrepContentText(text, ctx(ignores));
    assert.match(filtered, /^--/m);
    assert.match(filtered, /visible\.ts/);
  });

  it('returns "No matches found" when every match line is ignored', () => {
    const text = [
      "ignored/a.ts:1:secret",
      "ignored/b.ts:2:secret",
      "--",
    ].join("\n");
    assert.equal(filterGrepContentText(text, ctx(ignores)), "No matches found");
  });

  it("keeps all lines when nothing is ignored", () => {
    const text = "visible.ts:1:ok\nignored/secret.ts:1:secret";
    assert.equal(filterGrepContentText(text, ctx(new Map())), text);
  });

  it("applies flat ignore arrays to every source mount", () => {
    const text = "dist/out.js:1:bundle";
    assert.equal(filterGrepContentText(text, ctx(["dist/**"])), "No matches found");
  });
});
