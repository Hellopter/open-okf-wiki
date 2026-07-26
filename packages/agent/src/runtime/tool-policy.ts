/**
 * Pi built-in tool allowlists by wiki agent role / phase (ADR 0030).
 * Prefer Pi tools; never enable bash for Semantic Workflow roles.
 */

/** Pi coding-agent built-in tool names we may enable. */
export type PiFsToolName = "read" | "grep" | "find" | "ls" | "write" | "edit";

/** Semantic roles that own a tool allowlist. */
export type WikiAgentRole =
  | "plan"
  | "root_research"
  | "root_write"
  | "domain"
  | "leaf"
  | "reviewer"
  | "operator_chat";

const READ_ONLY: readonly PiFsToolName[] = ["read", "grep", "find", "ls"] as const;

const READ_WRITE: readonly PiFsToolName[] = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
] as const;

/** Forbidden for all Semantic Workflow roles. */
export const FORBIDDEN_WIKI_TOOLS = ["bash"] as const;

/**
 * Tool names passed to `createAgentSession({ tools })`.
 * Always a subset of Pi built-ins; never includes bash.
 */
export function toolNamesForRole(role: WikiAgentRole): readonly PiFsToolName[] {
  switch (role) {
    case "plan":
    case "root_research":
    case "domain":
    case "leaf":
    case "reviewer":
      return READ_ONLY;
    case "operator_chat":
      // Operator conversation may explore the Workspace read-only (Operations
      // deny `.okf-wiki/` product meta); writes still happen only inside
      // run-owned child Sessions via wiki_produce / wiki_repair.
      return READ_ONLY;
    case "root_write":
      return READ_WRITE;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/** True when the role may use write/edit (still scoped by Operations wrappers). */
export function roleMayWrite(role: WikiAgentRole): boolean {
  return role === "root_write";
}

/**
 * Tools an operator may select for the chat Session (workspace.operatorTools).
 * `bash` is a stock Pi tool with no Operations wrapper — explicit trust opt-in
 * only, never available to Semantic Workflow roles.
 */
export const OPERATOR_SELECTABLE_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export type OperatorSelectableTool = (typeof OPERATOR_SELECTABLE_TOOLS)[number];

/**
 * Resolve the operator tool list from a workspace selection.
 * undefined → read-only default; empty array → product tools only.
 * Unknown names throw rather than being silently dropped.
 */
export function resolveOperatorToolNames(
  selection: readonly string[] | undefined,
): readonly OperatorSelectableTool[] {
  if (selection === undefined) return READ_ONLY as readonly OperatorSelectableTool[];
  const out: OperatorSelectableTool[] = [];
  for (const name of selection) {
    if (!(OPERATOR_SELECTABLE_TOOLS as readonly string[]).includes(name)) {
      throw new Error(`unknown operator tool: ${name}`);
    }
    if (!out.includes(name as OperatorSelectableTool)) {
      out.push(name as OperatorSelectableTool);
    }
  }
  return out;
}

/** Runtime safety check for factory tests and guards. */
export function assertSafeWikiToolList(
  tools: readonly string[],
): asserts tools is readonly PiFsToolName[] {
  for (const name of tools) {
    if ((FORBIDDEN_WIKI_TOOLS as readonly string[]).includes(name)) {
      throw new Error(`forbidden wiki tool: ${name}`);
    }
    if (
      name !== "read" &&
      name !== "grep" &&
      name !== "find" &&
      name !== "ls" &&
      name !== "write" &&
      name !== "edit"
    ) {
      throw new Error(`unknown or disallowed tool for wiki session: ${name}`);
    }
  }
}

export function isReadOnlyToolList(tools: readonly string[]): boolean {
  return tools.every((t) => t === "read" || t === "grep" || t === "find" || t === "ls");
}
