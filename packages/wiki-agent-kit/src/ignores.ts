import path from "node:path";
import { defaultsDirectory } from "./layout.js";
import { readText } from "./storage.js";

interface IgnorePreset { label: string; patterns: string[] }
let defaultsPromise: Promise<string[]> | undefined;
let presetsPromise: Promise<Record<string, IgnorePreset>> | undefined;

async function defaults(): Promise<string[]> {
  defaultsPromise ??= readText(path.join(defaultsDirectory, "default-source-ignores.json")).then((text) => JSON.parse(text) as string[]);
  return defaultsPromise;
}

async function presets(): Promise<Record<string, IgnorePreset>> {
  presetsPromise ??= readText(path.join(defaultsDirectory, "ignore-presets.json")).then((text) => JSON.parse(text) as Record<string, IgnorePreset>);
  return presetsPromise;
}

export async function effectiveIgnores(source: { applyDefaultIgnores?: boolean; ignore?: string[]; presets?: string[] }): Promise<string[]> {
  const selected = source.applyDefaultIgnores === false ? [] : [...await defaults()];
  const catalog = await presets();
  for (const id of source.presets ?? []) {
    const preset = catalog[id];
    if (!preset) throw new Error(`unknown ignore preset: ${id}`);
    selected.push(...preset.patterns);
  }
  selected.push(...(source.ignore ?? []).map((item) => item.trim()).filter(Boolean));
  return [...new Set(selected)];
}

function normalize(value: string): string {
  let result = value.replaceAll("\\", "/");
  while (result.startsWith("./")) result = result.slice(2);
  return result.replace(/^\/+/, "").replace(/\/$/, "");
}

function glob(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    if (current === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else expression += "[^/]*";
    } else if (current === "?") expression += "[^/]";
    else expression += ".+^${}()|[]\\".includes(current) ? `\\${current}` : current;
  }
  return new RegExp(`${expression}$`);
}

export function pathIgnored(relativePath: string, patterns: string[]): boolean {
  const candidate = normalize(relativePath);
  if (!candidate) return false;
  return patterns.some((raw) => {
    const pattern = normalize(raw.trim());
    if (!pattern) return false;
    if (!pattern.includes("/") && !/[?*]/.test(pattern)) return candidate === pattern || candidate.startsWith(`${pattern}/`);
    if (!pattern.includes("/")) return glob(pattern).test(path.posix.basename(candidate));
    if (pattern.endsWith("/**")) return candidate === pattern.slice(0, -3) || candidate.startsWith(pattern.slice(0, -2));
    return glob(pattern).test(candidate);
  });
}
