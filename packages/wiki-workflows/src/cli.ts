export type WikiCliCommand =
  | { action: "run"; focus?: string; regenerate: boolean }
  | { action: "status"; runId?: string }
  | { action: "runs" }
  | { action: "pause" }
  | { action: "resume"; runId?: string }
  | { action: "cancel"; runId?: string };

export function parseWikiCliCommand(raw: string): WikiCliCommand {
  const values = tokenize(raw);
  if (values.length === 0) return { action: "run", regenerate: false };

  const action = values[0]!.toLowerCase();
  const rest = values.slice(1);
  switch (action) {
    case "regenerate":
      return { action: "run", regenerate: true, focus: joinedFocus(rest) };
    case "status":
      return withOptionalRunId(action, optionalRunId(rest, "status"));
    case "runs":
      requireNoArguments(rest, "runs");
      return { action };
    case "pause":
      requireNoArguments(rest, "pause");
      return { action };
    case "resume":
      return withOptionalRunId(action, optionalRunId(rest, "resume"));
    case "cancel":
      return withOptionalRunId(action, optionalRunId(rest, "cancel"));
    default:
      return { action: "run", regenerate: false, focus: joinedFocus(values) };
  }
}

function withOptionalRunId<T extends "status" | "resume" | "cancel">(
  action: T,
  runId: string | undefined,
): Extract<WikiCliCommand, { action: T }> {
  return (runId ? { action, runId } : { action }) as Extract<WikiCliCommand, { action: T }>;
}

export function renderWikiRun(run: WikiRunView | undefined): string {
  if (!run) return "Wiki: no run.";
  const focus = run.focus ? ` | ${run.focus}` : "";
  const error = run.error ? `\n${run.error}` : "";
  return `Wiki ${run.id} | ${run.operation} | ${run.status}${focus}${error}`;
}

export function renderWikiRuns(runs: readonly WikiRunView[]): string {
  if (runs.length === 0) return "Wiki runs: none.";
  return ["Wiki runs", ...runs.map((run) => {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const updated = run.updatedAt ? `${run.updatedAt} | ` : "";
    return `${updated}${run.id} | ${run.status}${focus}`;
  })].join("\n");
}

export function renderWikiEvent(event: WikiRunEvent): string {
  const stage = textValue(event.data?.stage);
  const completed = numberValue(event.data?.completed);
  const total = numberValue(event.data?.total);
  const progress = completed !== undefined && total !== undefined ? ` ${completed}/${total}` : "";
  const prefix = stage ? `[${stage}${progress}] ` : "";
  const message = event.message.trim() || humanize(event.type);
  return `${prefix}${message}`;
}

export function wikiCliHelp(): string {
  return [
    "Usage:",
    "  /wiki [focus]",
    "  /wiki regenerate [focus]",
    "  /wiki status [run-id]",
    "  /wiki runs",
    "  /wiki pause",
    "  /wiki resume [run-id]",
    "  /wiki cancel [run-id]",
  ].join("\n");
}

function tokenize(input: string): string[] {
  const values: string[] = [];
  for (const match of input.matchAll(/"([^\"]*)"|'([^']*)'|(\S+)/g)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return values;
}

function joinedFocus(values: string[]): string | undefined {
  return values.join(" ").trim() || undefined;
}

function optionalRunId(values: string[], action: string): string | undefined {
  if (values.length > 1) throw new Error(`Usage: /wiki ${action} [run-id]`);
  const value = values[0];
  if (value && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Invalid Wiki run id");
  }
  return value;
}

function requireNoArguments(values: string[], action: string): void {
  if (values.length > 0) throw new Error(`/wiki ${action} does not accept arguments`);
}

function humanize(value: string): string {
  const normalized = value.replaceAll("_", " ").trim();
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Wiki updated";
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
import type { WikiRunEvent, WikiRunView } from "./producer-types.js";
