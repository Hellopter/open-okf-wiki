import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterSlashCommands,
  insertSlashCommand,
  isCompactSlashPrompt,
  isControlSlashPrompt,
  isSlashCommandPrompt,
  mergeSlashCommands,
  planSessionSend,
  type SlashCommandOption,
} from "./slash-commands.ts";

const CATALOG: SlashCommandOption[] = [
  { name: "wiki", description: "Start a Wiki Run" },
  { name: "status", description: "Summarize status" },
  { name: "repair", description: "Repair staging", argumentHint: "<notes>" },
];

describe("mergeSlashCommands", () => {
  it("adds control compact/abort-compact and sorts by name", () => {
    const merged = mergeSlashCommands(CATALOG);
    assert.deepEqual(
      merged.map((c) => c.name),
      ["abort-compact", "compact", "repair", "status", "wiki"],
    );
  });

  it("control overrides catalog description for same name", () => {
    const merged = mergeSlashCommands([
      { name: "compact", description: "from catalog" },
      ...CATALOG,
    ]);
    const compact = merged.find((c) => c.name === "compact");
    assert.equal(
      compact?.description,
      "Compact session context to free window budget (use /compact stop while busy)",
    );
  });
});

describe("filterSlashCommands", () => {
  const all = mergeSlashCommands(CATALOG);

  it("hides when not a slash prompt", () => {
    assert.equal(filterSlashCommands(all, "hello"), null);
    assert.equal(filterSlashCommands(all, ""), null);
  });

  it("filters by prefix after slash", () => {
    const hits = filterSlashCommands(all, "/w");
    assert.ok(hits);
    assert.deepEqual(
      hits.map((c) => c.name),
      ["wiki"],
    );
  });

  it("shows all when only slash", () => {
    const hits = filterSlashCommands(all, "/");
    assert.ok(hits);
    assert.equal(hits.length, all.length);
  });

  it("hides once args start or path-like token", () => {
    assert.equal(filterSlashCommands(all, "/wiki notes"), null);
    assert.equal(filterSlashCommands(all, "/home/x"), null);
  });
});

describe("insertSlashCommand + isCompactSlashPrompt", () => {
  it("inserts trailing space", () => {
    assert.equal(insertSlashCommand("compact"), "/compact ");
  });

  it("detects compact control prompts", () => {
    assert.equal(isCompactSlashPrompt("/compact"), true);
    assert.equal(isCompactSlashPrompt("  /compact  "), true);
    assert.equal(isCompactSlashPrompt("/compact now"), true);
    assert.equal(isCompactSlashPrompt("/compact stop"), true);
    assert.equal(isCompactSlashPrompt("/wiki"), false);
    assert.equal(isCompactSlashPrompt("compact"), false);
  });
});

describe("isSlashCommandPrompt + isControlSlashPrompt", () => {
  it("accepts bare slash commands and rejects paths / plain text", () => {
    assert.equal(isSlashCommandPrompt("/compact"), true);
    assert.equal(isSlashCommandPrompt("/compact stop"), true);
    assert.equal(isSlashCommandPrompt("/wiki notes"), true);
    assert.equal(isSlashCommandPrompt("/home/x"), false);
    assert.equal(isSlashCommandPrompt("hello"), false);
    assert.equal(isSlashCommandPrompt("/"), false);
  });

  it("detects control names compact and abort-compact only", () => {
    assert.equal(isControlSlashPrompt("/compact"), true);
    assert.equal(isControlSlashPrompt("/compact stop"), true);
    assert.equal(isControlSlashPrompt("/COMPACT STOP"), true);
    assert.equal(isControlSlashPrompt("/abort-compact"), true);
    assert.equal(isControlSlashPrompt("/wiki"), false);
    assert.equal(isControlSlashPrompt("steer me"), false);
  });
});

describe("planSessionSend", () => {
  it("returns null for blank text", () => {
    assert.equal(planSessionSend("   ", false), null);
  });

  it("uses prompt when idle for normal text and slash", () => {
    assert.deepEqual(planSessionSend("hello", false), {
      command: { type: "prompt", text: "hello" },
      appendOptimisticUser: true,
    });
    assert.deepEqual(planSessionSend("/wiki notes", false), {
      command: { type: "prompt", text: "/wiki notes" },
      appendOptimisticUser: true,
    });
  });

  it("uses steer when busy for non-slash text", () => {
    assert.deepEqual(planSessionSend("redirect", true), {
      command: { type: "steer", text: "redirect" },
      appendOptimisticUser: true,
    });
  });

  it("always uses prompt for /compact stop (never idle compact command)", () => {
    const plan = planSessionSend("/compact stop", true);
    assert.deepEqual(plan, {
      command: { type: "prompt", text: "/compact stop" },
      appendOptimisticUser: false,
    });
  });

  it("uses prompt for bare /compact and skips optimistic user bubble", () => {
    assert.deepEqual(planSessionSend("/compact", false), {
      command: { type: "prompt", text: "/compact" },
      appendOptimisticUser: false,
    });
    assert.deepEqual(planSessionSend("/abort-compact", true), {
      command: { type: "prompt", text: "/abort-compact" },
      appendOptimisticUser: false,
    });
  });

  it("keeps template slash as prompt while busy (server may reject if busy)", () => {
    assert.deepEqual(planSessionSend("/wiki", true), {
      command: { type: "prompt", text: "/wiki" },
      appendOptimisticUser: true,
    });
  });
});
