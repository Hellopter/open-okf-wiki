/**
 * Operator slash commands (Claude Code-style prompt templates).
 *
 * A command is a deterministic intent entry point, not a session mode:
 * `/wiki notes` expands into a prompt sent through the normal single write
 * path (SessionTurn → AgentSession.prompt), and a Wiki Run still begins only
 * when the agent genuinely calls `wiki_produce` (ADR 0032).
 *
 * Template syntax follows Pi prompt templates for the subset we use
 * ($1..$9, $@, $ARGUMENTS, ${N:-default}, ${@:-default}); Pi does not export
 * its substituteArgs helper, so the subset is implemented and tested here.
 */

export type OperatorCommand = {
  /** Command name without the leading slash (`wiki` → `/wiki`). */
  name: string;
  description: string;
  /** Autocomplete hint: `<required>` / `[optional]` arguments. */
  argumentHint?: string;
  /** Prompt template body (argument placeholders allowed). */
  content: string;
};

export const OPERATOR_COMMANDS: readonly OperatorCommand[] = [
  {
    name: "wiki",
    description: "Start a Wiki Run for this Workspace (plan → produce → publish gates)",
    argumentHint: "[notes for the planner]",
    content: [
      "Call the `wiki_produce` tool now to start a Wiki Run for this Workspace.",
      "Do not ask for confirmation first — the Run has its own plan and",
      "publication gates where the operator decides.",
      "Operator notes for the planner: ${@:-(none)}",
    ].join("\n"),
  },
  {
    name: "repair",
    description: "Repair the latest Staging Wiki with operator defect notes",
    argumentHint: "<defect notes>",
    content: [
      "Call the `wiki_repair` tool now on the latest Staging Wiki.",
      "Defect notes from the operator:",
      "${@:-(no notes given — ask one brief question about what to repair instead of guessing)}",
    ].join("\n"),
  },
  {
    name: "status",
    description: "Summarize Workspace, model, and latest Wiki Run state",
    content: [
      "Call the `session_status` tool now, then summarize concisely:",
      "configured sources, selected models, the latest Wiki Run outcome,",
      "and any pending plan/publication gate.",
    ].join("\n"),
  },
];

/** Stable list for autocomplete endpoints (name/description/hint only is fine to expose). */
export function listOperatorCommands(): readonly OperatorCommand[] {
  return OPERATOR_COMMANDS;
}

/** Bash-style-lite argv split honoring single/double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of argsString) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) args.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) args.push(current);
  return args;
}

/**
 * Substitute the supported placeholder subset. Values are inserted verbatim
 * (no recursive substitution).
 */
export function substituteArgs(content: string, args: readonly string[]): string {
  const all = args.join(" ");
  return (
    content
      .replace(/\$\{(\d+):-([^}]*)\}/g, (_m, n: string, fallback: string) => {
        const value = args[Number(n) - 1];
        return value === undefined || value === "" ? fallback : value;
      })
      .replace(/\$\{(?:@|ARGUMENTS):-([^}]*)\}/g, (_m, fallback: string) =>
        all === "" ? fallback : all,
      )
      // `\b` cannot follow `@` (non-word char), so match the two forms apart.
      .replace(/\$@/g, all)
      .replace(/\$ARGUMENTS\b/g, all)
      .replace(/\$(\d+)\b/g, (_m, n: string) => args[Number(n) - 1] ?? "")
  );
}

export type ExpandOperatorCommandResult =
  /** Input was not a slash command (including path-like `/home/x`). */
  | { kind: "not_command" }
  /** Leading-slash token that matches no registered command. */
  | { kind: "unknown"; command: string }
  | { kind: "expanded"; command: string; prompt: string };

/**
 * Detect and expand a leading-slash operator command.
 *
 * A first token containing `/` after the leading slash (e.g. `/home/user/x`)
 * is treated as a path, not a command, so pasted absolute paths flow to the
 * model instead of erroring.
 */
export function expandOperatorCommand(text: string): ExpandOperatorCommandResult {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return { kind: "not_command" };
  const match = /^\/(\S+)([\s\S]*)$/.exec(trimmed);
  if (!match) return { kind: "not_command" };
  const token = match[1]!;
  if (token.includes("/")) return { kind: "not_command" };
  const command = OPERATOR_COMMANDS.find((c) => c.name === token.toLowerCase());
  if (!command) return { kind: "unknown", command: token };
  const args = parseCommandArgs(match[2] ?? "");
  return {
    kind: "expanded",
    command: command.name,
    prompt: substituteArgs(command.content, args),
  };
}
