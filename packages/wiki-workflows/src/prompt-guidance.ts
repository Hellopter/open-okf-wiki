import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { WikiNodeKind } from "./workflow-types.js";

type GuidanceName = "common" | "research" | "synthesis" | "write" | "review";

const guidanceCache = new Map<GuidanceName, Promise<string>>();
const templateCache = new Map<WikiPageTemplateType, Promise<string>>();

/** A skeletal page structure that is selected by the finalized WikiSpec. */
export type WikiPageTemplateType = "overview" | "architecture" | "module" | "flow" | "concept";

/**
 * Guidance options supplied by the workflow after synthesis. Templates are opt-in
 * so a writer only receives structures that apply to its DomainPacket.
 */
export interface WikiPromptGuidanceOptions {
  pageTypes?: readonly WikiPageTemplateType[];
}

/** Explicitly includes the synthesis coordinator phase. */
export type WikiPromptGuidanceKind = WikiNodeKind | "synthesis";

export async function loadWikiPromptGuidance(
  kind: WikiPromptGuidanceKind,
  language: "zh" | "en",
  options: WikiPromptGuidanceOptions = {},
): Promise<string> {
  const names: GuidanceName[] = ["common", guidanceFor(kind)];
  const templates = uniquePageTypes(options.pageTypes ?? []);
  const content = await Promise.all([
    ...names.map(async (name) => await loadGuidance(name)),
    ...templates.map(async (pageType) => await loadTemplate(pageType)),
  ]);
  return content.join("\n\n").replaceAll("{{language}}", language === "en" ? "English" : "Chinese");
}

function guidanceFor(kind: WikiPromptGuidanceKind): GuidanceName {
  if (kind === "research") return "research";
  if (kind === "synthesis") return "synthesis";
  if (kind === "write" || kind === "repair") return "write";
  return "review";
}

function loadGuidance(name: GuidanceName): Promise<string> {
  const cached = guidanceCache.get(name);
  if (cached) return cached;
  const location = fileURLToPath(new URL(`../skills/git-native-wiki/references/${name}.md`, import.meta.url));
  const loaded = readFile(location, "utf8");
  guidanceCache.set(name, loaded);
  return loaded;
}

function loadTemplate(pageType: WikiPageTemplateType): Promise<string> {
  const cached = templateCache.get(pageType);
  if (cached) return cached;
  const location = fileURLToPath(new URL(`../skills/git-native-wiki/references/templates/${pageType}.md`, import.meta.url));
  const loaded = readFile(location, "utf8");
  templateCache.set(pageType, loaded);
  return loaded;
}

function uniquePageTypes(pageTypes: readonly WikiPageTemplateType[]): WikiPageTemplateType[] {
  return [...new Set(pageTypes)];
}
