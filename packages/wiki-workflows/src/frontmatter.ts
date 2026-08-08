import YAML from "yaml";

export interface ParsedPage {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parsePage(text: string): ParsedPage {
  if (!text.startsWith("---\n")) throw new Error("missing YAML frontmatter");
  const end = text.indexOf("\n---", 4);
  if (end < 0) throw new Error("unterminated YAML frontmatter");
  const frontmatter = YAML.parse(text.slice(4, end));
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("frontmatter must be a mapping");
  }
  return { frontmatter: frontmatter as Record<string, unknown>, body: text.slice(end + 4).replace(/^\r?\n/, "") };
}

export function sourceResources(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
