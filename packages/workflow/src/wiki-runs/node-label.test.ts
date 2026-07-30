import assert from "node:assert/strict";
import test from "node:test";
import { labelForNode, parentKeyForNode, parseNodeDetail } from "./node-label.js";

test("labelForNode uses domain title and leaf question", () => {
  assert.equal(
    labelForNode("research.domain", "research.domain.core", { domainId: "core", title: "Core" }),
    "Core",
  );
  assert.equal(
    labelForNode("research.leaf", "research.leaf.core.1", {
      domainId: "core",
      questionIndex: 1,
      question: "What is the module boundary?",
    }),
    "What is the module boundary?",
  );
  assert.equal(labelForNode("write.root", "write.root"), "Write");
  assert.notEqual(
    labelForNode("research.leaf", "research.leaf.core.1", { questionIndex: 1, domainId: "core" }),
    "1",
  );
});

test("parentKeyForNode links leaf to domain", () => {
  assert.equal(
    parentKeyForNode("research.leaf", "research.leaf.core.1", { domainId: "core" }),
    "research.domain.core",
  );
  assert.equal(
    parentKeyForNode("research.domain", "research.domain.core", { domainId: "core" }),
    "plan",
  );
});

test("parseNodeDetail keeps only known fields", () => {
  const d = parseNodeDetail({ domainId: "x", title: "X", secret: "nope", questionIndex: 2 });
  assert.deepEqual(d, { domainId: "x", title: "X", questionIndex: 2 });
});
