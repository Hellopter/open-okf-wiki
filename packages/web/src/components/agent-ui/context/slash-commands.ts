/**
 * Pure slash-command autocomplete helpers for the session composer.
 */

export type SlashCommandOption = {
  /** Command name without leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
};

/**
 * Control-plane slash commands that are not prompt templates.
 * Server may also list these later; client merges by name.
 * Must stay aligned with agent OPERATOR_COMMANDS kind: "control".
 */
export const CONTROL_SLASH_COMMANDS: readonly SlashCommandOption[] = [
  {
    name: "compact",
    description: "Compact session context to free window budget (use /compact stop while busy)",
    argumentHint: "[stop]",
  },
  {
    name: "abort-compact",
    description: "Abort in-progress manual or auto compaction",
  },
];

const CONTROL_SLASH_NAMES = new Set(
  CONTROL_SLASH_COMMANDS.map((command) => command.name.toLowerCase()),
);

/** Merge API catalog with control commands; control wins on name collision. */
export function mergeSlashCommands(
  catalog: readonly SlashCommandOption[],
  control: readonly SlashCommandOption[] = CONTROL_SLASH_COMMANDS,
): SlashCommandOption[] {
  const byName = new Map<string, SlashCommandOption>();
  for (const command of catalog) {
    byName.set(command.name.toLowerCase(), command);
  }
  for (const command of control) {
    byName.set(command.name.toLowerCase(), command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Filter commands while the prompt is a bare slash prefix (`/`, `/wi`).
 * Returns null when autocomplete should hide (not a slash prompt, or args started).
 */
export function filterSlashCommands(
  commands: readonly SlashCommandOption[],
  prompt: string,
): SlashCommandOption[] | null {
  if (!prompt.startsWith("/")) return null;
  const rest = prompt.slice(1);
  // Path-like first token (`/home/...`) is not a command.
  if (rest.includes("/")) return null;
  // Once the operator types a space, they are filling arguments.
  if (/\s/.test(rest)) return null;
  const query = rest.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(query));
}

/** Insert a selected slash command (trailing space so args are ready). */
export function insertSlashCommand(name: string): string {
  return `/${name} `;
}

/**
 * True when text looks like a leading-slash operator command (not a path).
 * First token must be non-empty and must not contain `/`.
 */
export function isSlashCommandPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const token = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
  return token.length > 0 && !token.includes("/");
}

/** Lowercase first slash token, or null when not a slash command. */
export function slashCommandName(text: string): string | null {
  if (!isSlashCommandPrompt(text)) return null;
  return (text.trim().slice(1).split(/\s/, 1)[0] ?? "").toLowerCase();
}

/**
 * True when the prompt is a control-plane slash (compact / abort-compact).
 * Control commands must go to the server as `{ type: "prompt" }` (never steer)
 * and should not append an optimistic user bubble.
 */
export function isControlSlashPrompt(text: string): boolean {
  const name = slashCommandName(text);
  return name !== null && CONTROL_SLASH_NAMES.has(name);
}

/** True when the prompt is the compact control command (optional trailing args ignored). */
export function isCompactSlashPrompt(text: string): boolean {
  return slashCommandName(text) === "compact";
}

/**
 * Decide wire command type + optimistic-user policy for composer send.
 * Slash control/template text always uses prompt so the server can intercept
 * control before the busy gate (`/compact stop` → stop_and_compact).
 */
export function planSessionSend(
  text: string,
  busy: boolean,
): {
  command: { type: "prompt" | "steer"; text: string };
  appendOptimisticUser: boolean;
} | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const isSlash = isSlashCommandPrompt(trimmed);
  return {
    command:
      isSlash || !busy
        ? { type: "prompt", text: trimmed }
        : { type: "steer", text: trimmed },
    appendOptimisticUser: !isControlSlashPrompt(trimmed),
  };
}
