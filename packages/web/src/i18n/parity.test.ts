/**
 * en/zh catalog parity: same key tree; leaf strings must differ unless allowlisted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "./en.ts";
import { zh } from "./zh.ts";

/** Paths (dot-joined) allowed to share the same string in en and zh. */
const ALLOW_SAME_PATHS = new Set([
  // Brand
  "app.brand",
  // Locale self-names stay native in both catalogs
  "locale.en",
  "locale.zh",
  // Shared product / technical terms
  "subnav.wiki",
  "wiki.breadcrumb",
  "common.id",
  "sources.colId",
  "settings.tabSkill",
  "settings.skillTitle",
  "globalSettings.colBaseUrl",
  "globalSettings.baseUrl",
  "globalSettings.shapeCompletions",
  "globalSettings.shapeResponses",
  "globalSettings.doctorTitle",
  "globalSettings.node",
  "globalSettings.git",
  // Path / URL / ignore-pattern placeholders (machine-facing examples)
  "workspaces.rootPlaceholder",
  "sources.pathPlaceholder",
  "sources.sourceIdPlaceholder",
  "sources.ignorePlaceholder",
  "globalSettings.modelIdPlaceholder",
  "globalSettings.baseUrlPlaceholder",
]);

type Leaf = { path: string; en: string; zh: string };

function walkLeaves(
  enNode: unknown,
  zhNode: unknown,
  path: string[] = [],
  out: Leaf[] = [],
): Leaf[] {
  if (typeof enNode === "string") {
    assert.equal(typeof zhNode, "string", `zh leaf missing or non-string at ${path.join(".")}`);
    out.push({ path: path.join("."), en: enNode, zh: zhNode as string });
    return out;
  }
  assert.equal(
    enNode !== null && typeof enNode === "object" && !Array.isArray(enNode),
    true,
    `en node is not a plain object at ${path.join(".") || "(root)"}`,
  );
  assert.equal(
    zhNode !== null && typeof zhNode === "object" && !Array.isArray(zhNode),
    true,
    `zh node is not a plain object at ${path.join(".") || "(root)"}`,
  );
  const enObj = enNode as Record<string, unknown>;
  const zhObj = zhNode as Record<string, unknown>;
  const enKeys = Object.keys(enObj).sort();
  const zhKeys = Object.keys(zhObj).sort();
  assert.deepEqual(zhKeys, enKeys, `key mismatch at ${path.join(".") || "(root)"}`);
  for (const key of enKeys) {
    walkLeaves(enObj[key], zhObj[key], [...path, key], out);
  }
  return out;
}

describe("i18n en/zh parity", () => {
  const leaves = walkLeaves(en, zh);

  it("zh leaf strings differ from en unless allowlisted", () => {
    const failures: string[] = [];
    for (const leaf of leaves) {
      if (leaf.en === leaf.zh && !ALLOW_SAME_PATHS.has(leaf.path)) {
        failures.push(`${leaf.path}: ${JSON.stringify(leaf.en)}`);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `untranslated zh leaves (add translation or allowlist):\n${failures.join("\n")}`,
    );
  });

  it("allowlist entries exist and are still identical", () => {
    const byPath = new Map(leaves.map((l) => [l.path, l]));
    for (const path of ALLOW_SAME_PATHS) {
      const leaf = byPath.get(path);
      assert.ok(leaf, `allowlist path missing from catalogs: ${path}`);
      assert.equal(
        leaf.en,
        leaf.zh,
        `allowlist path is translated (remove from allowlist): ${path}`,
      );
    }
  });
});
