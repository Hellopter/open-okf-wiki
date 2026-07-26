import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatToolDisplay, parseToolInput, toolPathLabel } from "./summary.ts";

describe("parseToolInput", () => {
  it("accepts structured object args", () => {
    assert.deepEqual(parseToolInput({ path: "a.ts", offset: 1 }), {
      path: "a.ts",
      offset: 1,
    });
  });

  it("parses JSON string args for legacy callers", () => {
    assert.deepEqual(parseToolInput('{"path":"b.ts"}'), { path: "b.ts" });
  });

  it("returns null for empty / non-object values", () => {
    assert.equal(parseToolInput(undefined), null);
    assert.equal(parseToolInput(null), null);
    assert.equal(parseToolInput(""), null);
    assert.equal(parseToolInput("not-json"), null);
    assert.equal(parseToolInput([1, 2]), null);
  });
});

describe("toolPathLabel", () => {
  it("returns basename-ish path labels", () => {
    assert.equal(toolPathLabel("src/agent/main.ts"), "main.ts");
    assert.equal(toolPathLabel("main.ts"), "main.ts");
    assert.equal(toolPathLabel("a\\b\\c.md"), "c.md");
  });
});

describe("formatToolDisplay", () => {
  it("formats read tools from object args", () => {
    const display = formatToolDisplay("read", {
      path: "packages/web/src/main.tsx",
      offset: 10,
      limit: 40,
    });
    assert.equal(display.title, "read");
    assert.equal(display.subtitle, "main.tsx");
    assert.deepEqual(display.args, ["offset=10", "limit=40"]);
    assert.equal(display.kind, "output-only");
    // read must be expandable when tool.output exists (never header-only)
    assert.notEqual(display.headerOnly, true);
  });

  it("formats write tools with content preview from object args", () => {
    const display = formatToolDisplay("write", {
      path: "wiki/overview.md",
      content: "# Hello",
    });
    assert.equal(display.title, "write");
    assert.equal(display.subtitle, "overview.md");
    assert.equal(display.kind, "write-body");
    assert.equal(display.writePreview, "# Hello");
  });

  it("formats grep with pattern chip from object args", () => {
    const display = formatToolDisplay("grep", {
      path: "src",
      pattern: "AgentToolCall",
    });
    assert.equal(display.title, "grep");
    assert.equal(display.subtitle, "src");
    assert.deepEqual(display.args, ["pattern=AgentToolCall"]);
    assert.equal(display.kind, "output-only");
  });

  it("formats wiki_produce primary field from object args", () => {
    const display = formatToolDisplay("wiki_produce", { audience: "maintainers" });
    assert.equal(display.title, "wiki_produce");
    // audience is not a primary key — falls through to scalar pack
    assert.equal(display.subtitle, "audience=maintainers");
    assert.equal(display.headerOnly, true);
  });

  it("still accepts JSON string args", () => {
    const display = formatToolDisplay("read", '{"path":"foo/bar.ts"}');
    assert.equal(display.title, "read");
    assert.equal(display.subtitle, "bar.ts");
    assert.notEqual(display.headerOnly, true);
  });
});
