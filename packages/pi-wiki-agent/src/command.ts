import type { WikiLanguage } from "./core.js";

export type WikiCommand =
  | { action: "open" }
  | { action: "help" }
  | { action: "generate"; focus?: string }
  | { action: "approve"; runId?: string }
  | { action: "init"; name?: string; wikiLanguage?: WikiLanguage; force: boolean }
  | { action: "status" }
  | { action: "pause" | "resume" | "stop"; workflowRunId?: string }
  | { action: "source-list" }
  | { action: "source-add-clone"; url: string; id?: string }
  | { action: "source-add-link"; path: string; id?: string }
  | { action: "source-remove"; sourceId: string };

export class WikiCommandError extends Error {}

export interface WikiArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

const KNOWN_SUBCOMMANDS = new Set([
  "help", "generate", "approve", "init", "status", "pause", "resume", "stop", "source", "-h", "--help",
]);

const ARGUMENT_COMPLETIONS: WikiArgumentCompletion[] = [
  { value: "help", label: "help", description: "Show /wiki command help" },
  { value: "status --json", label: "status --json", description: "Show workspace and run state as JSON" },
  { value: "init", label: "init", description: "Initialize a Wiki workspace in the current project" },
  { value: "generate", label: "generate", description: "Create a Wiki plan and generate or propose it" },
  { value: "approve", label: "approve", description: "Approve the current proposed Wiki plan" },
  { value: "resume", label: "resume", description: "Resume a paused Wiki run" },
  { value: "source", label: "source", description: "List, add, or remove sources" },
  { value: "source list", label: "source list", description: "List registered sources" },
  { value: "source add clone", label: "source add clone", description: "Clone a git URL as a source" },
  { value: "source add link", label: "source add link", description: "Link a local path as a source" },
  { value: "source remove", label: "source remove", description: "Remove a registered source" },
  { value: "pause", label: "pause", description: "Pause an active Wiki run" },
  { value: "stop", label: "stop", description: "Stop an active Wiki run" },
];

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

/** Short usage line for error notifications; prefer /wiki help for the full surface. */
export const WIKI_COMMAND_USAGE =
  "Usage: /wiki | help | status --json | init | generate [focus] | approve [run-id] | pause|resume|stop [run-id] | source list|add|remove";

export function formatWikiHelp(): string {
  return [
    "OKF Wiki — source-grounded repository Wiki production",
    "",
    "Usage:",
    "  /wiki                         # open the live Navigator",
    "  /wiki help",
    "  /wiki status --json",
    "  /wiki init [--name name] [--lang en|zh] [--force]",
    "  /wiki generate [focus]",
    "  /wiki approve [run-id]",
    "  /wiki pause|resume|stop [run-id]",
    "  /wiki source list",
    "  /wiki source add clone <url> [--id id]",
    "  /wiki source add link|path <path> [--id id]",
    "  /wiki source remove <id>",
    "",
    "Aliases: /wiki-help  /wiki-init  /wiki-generate  /wiki-source",
    "",
    "`generate` plans and writes when workspace approval is auto; otherwise it leaves a Markdown proposal.",
    "`approve` resumes the same run-scoped main-agent session.",
  ].join("\n");
}

export function getWikiArgumentCompletions(prefix: string): WikiArgumentCompletion[] {
  const lower = prefix.trim().toLowerCase();
  if (!lower) return ARGUMENT_COMPLETIONS.slice();
  return ARGUMENT_COMPLETIONS.filter(
    (item) => item.value.toLowerCase().startsWith(lower) || item.label.toLowerCase().startsWith(lower),
  );
}

/** Parse the intentionally small v5 `/wiki` command surface. */
export function parseWikiCommand(raw: string): WikiCommand {
  const input = raw.trim();
  if (!input) return { action: "open" };
  const args = tokens(input);
  const command = args[0]?.toLowerCase() ?? "";
  const rest = args.slice(1);

  if (command === "help" || command === "-h" || command === "--help") return { action: "help" };
  switch (command) {
    case "generate":
      return { action: "generate", focus: rest.join(" ").trim() || undefined };
    case "approve":
      if (rest.length > 1) throw new WikiCommandError("/wiki approve accepts at most one run id");
      return { action: "approve", runId: rest[0] };
    case "init": {
      const language = valueAfter(rest, "--lang");
      if (language && language !== "en" && language !== "zh") throw new WikiCommandError("--lang must be en or zh");
      return { action: "init", name: valueAfter(rest, "--name"), wikiLanguage: language as WikiLanguage | undefined, force: rest.includes("--force") };
    }
    case "status":
      if (rest.length === 1 && rest[0] === "--json") return { action: "status" };
      throw new WikiCommandError("/wiki status only supports --json; use /wiki for the Navigator.");
    case "pause":
    case "resume":
    case "stop":
      if (rest.length > 1) throw new WikiCommandError(`/wiki ${command} accepts at most one run id`);
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
      if (args.length === 1 && (!KNOWN_SUBCOMMANDS.has(command) || input.startsWith("--"))) {
        throw new WikiCommandError(`Unknown subcommand "${command}". Use /wiki help or /wiki generate ${command}.`);
      }
      return { action: "generate", focus: input };
  }
}
