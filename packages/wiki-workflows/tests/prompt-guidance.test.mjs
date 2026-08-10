import assert from "node:assert/strict";
import test from "node:test";
import { loadWikiPromptGuidance } from "../dist/prompt-guidance.js";

test("Chinese guidance prefers source-authored domain and concept names", async () => {
  const research = normalizeWhitespace(await loadWikiPromptGuidance("research", "zh"));
  assert.match(research, /Chinese name found in source code or comments/);
  assert.match(research, /Record source-authored domain and concept names or aliases/);

  const synthesis = normalizeWhitespace(await loadWikiPromptGuidance("synthesis", "zh"));
  assert.match(synthesis, /source-authored Chinese domain and concept names/);
  assert.match(synthesis, /take precedence over translated English names/);

  const write = normalizeWhitespace(await loadWikiPromptGuidance("write", "zh", { pageTypes: ["concept"] }));
  assert.match(write, /preserve source-authored Chinese domain and concept names/);
  assert.match(write, /Do not silently replace them with your own translations/);

  const review = normalizeWhitespace(await loadWikiPromptGuidance("review", "zh"));
  assert.match(review, /invented translation that displaced an established Chinese name/);
});

function normalizeWhitespace(value) {
  return value.replaceAll(/\s+/g, " ");
}
