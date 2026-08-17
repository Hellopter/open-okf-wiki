import assert from "node:assert/strict";
import test from "node:test";
import { derivedIndexPaths } from "../dist/lead.js";

test("derived indexes cover root, source, domain, and concept directories", () => {
  assert.deepEqual(derivedIndexPaths([
    "overview.md",
    "architecture.md",
    "api/source.md",
    "api/billing/domain.md",
    "api/billing/invoice/concept.md",
    "api/billing/invoice/models/line-item.md",
    "web/source.md",
    "web/billing/domain.md",
  ]), [
    "api/billing/index.md",
    "api/billing/invoice/index.md",
    "api/billing/invoice/models/index.md",
    "api/index.md",
    "index.md",
    "web/billing/index.md",
    "web/index.md",
  ]);
});
