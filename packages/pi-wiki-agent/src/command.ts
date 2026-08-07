import type { WikiLanguage, WikiRunMode } from "./core-adapter.js";

export type WikiCommand =
  | { action: "run"; mode: WikiRunMode; focus?: string }
  | { action: "init"; name?: string; wikiLanguage?: WikiLanguage; force: boolean }
  | { action: "status" }
  | { action: "pause" | "resume" | "stop"; workflowRunId?: string }
  | { action: "source-list" }
  | { action: "source-add-clone"; url: string; id?: string }
  | { action: "source-add-link"; path: string; id?: string }
  | { action: "source-remove"; sourceId: string };

export class WikiCommandError extends Error {}

function tokens(input: string): string[] {
  const parsed: string[] = [];
  for (const match of input.matchAll(/"([^\"]*)"|'([^']*)'|(\S+)/g)) parsed.push(match[1] ?? match[2] ?? match[3] ?? "");
  return parsed;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function requireValue(args: string[], flag: string): string {
  const value = valueAfter(args, flag);
  if (!value || value.startsWith("--")) throw new WikiCommandError(`${flag} requires a value`);
  return value;
}

function parseRun(raw: string): WikiCommand {
  const args = tokens(raw);
  let mode: WikiRunMode = "auto";
  if (args[0] === "--plan") mode = "plan";
  else if (args[0] === "--write") mode = "write";
  else if (args[0] === "--restart") mode = "restart";
  else if (args[0] === "--retry" && args[1] === "plan") mode = "retry-plan";
  else if (args[0] === "--retry" && args[1] === "write") mode = "retry-write";

  const prefix = mode === "retry-plan" || mode === "retry-write" ? 2 : mode === "auto" ? 0 : 1;
  const focus = args.slice(prefix).join(" ").trim() || undefined;
  return { action: "run", mode, focus };
}

/** Parse the intentionally small `/wiki` command surface. */
export function parseWikiCommand(raw: string): WikiCommand {
  const input = raw.trim();
  if (!input || input.startsWith("--")) return parseRun(input);
  const args = tokens(input);
  const command = args[0]?.toLowerCase();
  const rest = args.slice(1);

  switch (command) {
    case "init": {
      const language = valueAfter(rest, "--lang");
      if (language && language !== "en" && language !== "zh") throw new WikiCommandError("--lang must be en or zh");
      return { action: "init", name: valueAfter(rest, "--name"), wikiLanguage: language as WikiLanguage | undefined, force: rest.includes("--force") };
    }
    case "status":
      return { action: "status" };
    case "pause":
    case "resume":
    case "stop":
      return { action: command, workflowRunId: rest[0] };
    case "source": {
      const operation = rest[0]?.toLowerCase();
      if (operation === "list") return { action: "source-list" };
      if (operation === "remove") {
        const sourceId = rest[1] && !rest[1].startsWith("--") ? rest[1] : requireValue(rest, "--id");
        return { action: "source-remove", sourceId };
      }
      if (operation === "add") {
        const kind = rest[1]?.toLowerCase();
        const id = valueAfter(rest, "--id");
        if (kind === "clone") {
          const url = rest[2] && !rest[2].startsWith("--") ? rest[2] : requireValue(rest, "--url");
          return { action: "source-add-clone", url, id };
        }
        if (kind === "link" || kind === "path") {
          const path = rest[2] && !rest[2].startsWith("--") ? rest[2] : requireValue(rest, "--path");
          return { action: "source-add-link", path, id };
        }
      }
      throw new WikiCommandError("Usage: /wiki source list | add clone <url> [--id id] | add link|path <path> [--id id] | remove <id>");
    }
    default:
      return parseRun(input);
  }
}

export const WIKI_COMMAND_USAGE =
  "Usage: /wiki [--plan|--write|--restart|--retry plan|--retry write] [focus] | init [--name name] [--lang en|zh] [--force] | status | pause|resume|stop [workflow-run-id] | source list|add|remove";
