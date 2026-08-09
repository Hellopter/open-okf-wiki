import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { WikiNodeKind } from "./workflow-types.js";

type GuidanceName = "common" | "plan" | "research" | "write" | "review";

const guidanceCache = new Map<GuidanceName, Promise<string>>();

export async function loadWikiPromptGuidance(kind: WikiNodeKind, language: "zh" | "en"): Promise<string> {
  const names: GuidanceName[] = ["common", guidanceFor(kind)];
  const content = await Promise.all(names.map(async (name) => await loadGuidance(name)));
  return content.join("\n\n").replaceAll("{{language}}", language === "en" ? "English" : "Chinese");
}

function guidanceFor(kind: WikiNodeKind): GuidanceName {
  if (kind === "plan" || kind === "replan") return "plan";
  if (kind === "research") return "research";
  if (kind === "write" || kind === "repair") return "write";
  return "review";
}

function loadGuidance(name: GuidanceName): Promise<string> {
  let cached = guidanceCache.get(name);
  if (!cached) {
    const location = fileURLToPath(new URL(`../skills/git-native-wiki/references/${name}.md`, import.meta.url));
    cached = readFile(location, "utf8");
    guidanceCache.set(name, cached);
  }
  return cached;
}
