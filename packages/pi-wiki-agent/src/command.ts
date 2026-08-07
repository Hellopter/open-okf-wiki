import type { WikiLanguage, WikiRunMode } from "./core-adapter.js";

export type WikiCommand =
  | { action: "open" }
  | { action: "help" }
  | { action: "run"; mode: WikiRunMode; focus?: string }
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
  "help",
  "run",
  "init",
  "status",
  "pause",
  "resume",
  "stop",
  "source",
  "-h",
  "--help",
  "--plan",
  "--write",
  "--restart",
  "--retry",
]);

const RETIRED_OBSERVATION_SUBCOMMANDS = new Set(["agents", "inspect", "fleet", "focus", "logs"]);

const ARGUMENT_COMPLETIONS: WikiArgumentCompletion[] = [
  { value: "help", label: "help", description: "Show /wiki command help" },
  { value: "status --json", label: "status --json", description: "Show workspace and run state as JSON" },
  { value: "init", label: "init", description: "Initialize a Wiki workspace in the current project" },
  { value: "run", label: "run", description: "Start the Wiki workflow (optional focus text)" },
  { value: "source", label: "source", description: "List, add, or remove sources" },
  { value: "source list", label: "source list", description: "List registered sources" },
  { value: "source add clone", label: "source add clone", description: "Clone a git URL as a source" },
  { value: "source add link", label: "source add link", description: "Link a local path as a source" },
  { value: "source remove", label: "source remove", description: "Remove a registered source" },
  { value: "pause", label: "pause", description: "Pause an active wiki orchestration run" },
  { value: "resume", label: "resume", description: "Resume a paused wiki orchestration run" },
  { value: "stop", label: "stop", description: "Stop an active wiki orchestration run" },
  { value: "--plan", label: "--plan", description: "Plan mode: produce a plan and stop before write" },
  { value: "--write", label: "--write", description: "Write mode: approve plan and write candidates" },
  { value: "--restart", label: "--restart", description: "Restart the domain run from bootstrap" },
  { value: "--retry plan", label: "--retry plan", description: "Retry planning from the last checkpoint" },
  { value: "--retry write", label: "--retry write", description: "Retry writing from the last checkpoint" },
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

/** Short usage line for error notifications; prefer /wiki help for the full surface. */
export const WIKI_COMMAND_USAGE =
  "Usage: /wiki | help | status --json | init | run [focus] | --plan|--write|--restart|--retry plan|write [focus] | pause|resume|stop [id] | source list|add|remove  (see /wiki help)";

/** Multi-line help for `/wiki help` and alias `/wiki-help`. */
export function formatWikiHelp(): string {
  return [
    "OKF Wiki — checkpointed, source-grounded repository Wiki production",
    "",
    "This is @okf-wiki/pi-wiki-agent (repository Wiki workflow).",
    "It is not pi-llm-wiki (personal LLM knowledge-base wiki).",
    "",
    "Usage:",
    "  /wiki                         # open the live Navigator",
    "  /wiki help",
    "  /wiki status --json",
    "  /wiki init [--name name] [--lang en|zh] [--force]",
    "  /wiki run [focus]",
    "  /wiki --plan [focus]",
    "  /wiki --write [focus]",
    "  /wiki --restart [focus]",
    "  /wiki --retry plan|write [focus]",
    "  /wiki pause|resume|stop [orch-run-id]",
    "  /wiki source list",
    "  /wiki source add clone <url> [--id id]",
    "  /wiki source add link|path <path> [--id id]",
    "  /wiki source remove <id>",
    "",
    "Aliases:",
    "  /wiki-help  /wiki-init  /wiki-run  /wiki-source",
    "",
    "Notes:",
    "  - Empty /wiki opens one Navigator; it does not auto-start a run.",
    "  - Multi-word free text is treated as a run focus, e.g. /wiki auth model.",
    "  - Single unknown tokens error; use /wiki run <focus> for one-word focus.",
    "  - In the Navigator, select a phase, then an agent, then enter its execution stream.",
    "  - Project-local install requires the project to be trusted by Pi.",
    "  - Orch run IDs are session orchestration jobs; domain run IDs come from Bootstrap.",
  ].join("\n");
}

/** Pure argument completions for the /wiki command surface. */
export function getWikiArgumentCompletions(prefix: string): WikiArgumentCompletion[] {
  const lower = prefix.trim().toLowerCase();
  if (!lower) return ARGUMENT_COMPLETIONS.slice();
  return ARGUMENT_COMPLETIONS.filter(
    (item) => item.value.toLowerCase().startsWith(lower) || item.label.toLowerCase().startsWith(lower),
  );
}

/** Parse the intentionally small `/wiki` command surface. */
export function parseWikiCommand(raw: string): WikiCommand {
  const input = raw.trim();
  if (!input) return { action: "open" };

  const args = tokens(input);
  const command = args[0]?.toLowerCase() ?? "";
  const rest = args.slice(1);

  if (command === "help" || command === "-h" || command === "--help") {
    return { action: "help" };
  }

  // Mode flags at the start still mean "run".
  if (input.startsWith("--")) return parseRun(input);
  if (RETIRED_OBSERVATION_SUBCOMMANDS.has(command)) {
    throw new WikiCommandError(`/wiki ${command} was removed; use /wiki to observe a run.`);
  }

  switch (command) {
    case "run":
      return parseRun(rest.join(" "));
    case "init": {
      const language = valueAfter(rest, "--lang");
      if (language && language !== "en" && language !== "zh") throw new WikiCommandError("--lang must be en or zh");
      return {
        action: "init",
        name: valueAfter(rest, "--name"),
        wikiLanguage: language as WikiLanguage | undefined,
        force: rest.includes("--force"),
      };
    }
    case "status":
      if (rest.length === 1 && rest[0] === "--json") return { action: "status" };
      throw new WikiCommandError("/wiki status only supports --json; use /wiki for the Navigator.");
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
      throw new WikiCommandError(
        "Usage: /wiki source list | add clone <url> [--id id] | add link|path <path> [--id id] | remove <id>",
      );
    }
    default: {
      // Multi-word free text is a run focus. A single unknown token is an error
      // (use `/wiki run <focus>` for one-word focuses).
      if (args.length === 1 && !KNOWN_SUBCOMMANDS.has(command)) {
        throw new WikiCommandError(`Unknown subcommand "${command}". Use /wiki help or /wiki run ${command}.`);
      }
      return parseRun(input);
    }
  }
}
