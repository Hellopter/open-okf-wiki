import type {
  WikiContextStats,
  WikiHistoryEntry,
  WikiRunEvent,
  WikiRunProgress,
  WikiRunView,
  WikiTaskInspection,
  WikiTaskSnapshot,
} from "./producer-types.js";
import { formatLocalDateTime } from "./time-format.js";

export type WikiCliCommand =
  | { action: "run"; focus?: string; regenerate: boolean }
  | { action: "init"; workspace?: string; language: "zh" | "en"; exclude: string[]; defaultSourceIgnores: boolean }
  | { action: "source-add"; kind: "link"; localPath: string; name?: string; workspace?: string }
  | { action: "source-add"; kind: "clone"; url: string; ref?: string; name?: string; workspace?: string }
  | { action: "status"; runId?: string; taskId?: string; process?: boolean }
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
    case "init":
      return parseInit(rest);
    case "source":
      return parseSource(rest);
    case "regenerate":
      return { action: "run", regenerate: true, focus: joinedFocus(rest) };
    case "status":
      return parseStatus(rest);
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

function withOptionalRunId<T extends "resume" | "cancel">(
  action: T,
  runId: string | undefined,
): Extract<WikiCliCommand, { action: T }> {
  return (runId ? { action, runId } : { action }) as Extract<WikiCliCommand, { action: T }>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseStatus(values: string[]): Extract<WikiCliCommand, { action: "status" }> {
  let runId: string | undefined;
  let taskId: string | undefined;
  let process = false;
  let extra = false;
  for (const value of values) {
    if (value === "--process") {
      process = true;
      continue;
    }
    if (runId === undefined) {
      if (!SAFE_ID.test(value)) throw new Error("Invalid Wiki run id");
      runId = value;
      continue;
    }
    if (taskId === undefined) {
      if (!SAFE_ID.test(value)) throw new Error("Invalid Wiki task id");
      taskId = value;
      continue;
    }
    extra = true;
  }
  if (extra || (process && !taskId) || (taskId && !runId)) {
    throw new Error("Usage: /wiki status [run-id] [task-id] [--process]");
  }
  return {
    action: "status",
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(process ? { process } : {}),
  };
}

export function renderWikiRun(run: WikiRunView | undefined): string {
  if (!run) return "Wiki: no run.";
  if (!run.progress) {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const error = run.error ? `\n${run.error}` : "";
    return `Wiki ${run.id} | ${run.operation} | ${run.status}${focus}${error}`;
  }
  return renderWikiRunCard(run, run.progress);
}

export function renderWikiSnapshot(run: WikiRunView): string {
  return `${renderWikiRun(run)}\n\nsnapshot as of ${formatLocalDateTime(run.updatedAt)}`;
}

function renderWikiRunCard(run: WikiRunView, progress: WikiRunProgress): string {
  const elapsed = formatElapsed(run.createdAt, run.completedAt ?? run.updatedAt);
  const elapsedPart = elapsed ? `  [${elapsed}]` : "";
  const lines: string[] = [`Wiki ${run.id}  ${run.operation}  ${run.status}${elapsedPart}`];

  const stageSegments = [`stage  ${progress.stage}`];
  const batch = numberValue(progress.batch);
  const completed = numberValue(progress.completed);
  const total = numberValue(progress.total);
  if (batch !== undefined) stageSegments.push(`batch ${batch}`);
  if (completed !== undefined && total !== undefined) {
    const running = progress.tasks?.filter((task) => task.status === "running").length ?? 0;
    stageSegments.push(`${completed}/${total} done${running > 0 ? `, ${running} running` : ""}`);
  }
  lines.push(joinStageSegments(stageSegments));

  if (run.focus) lines.push(`focus  ${run.focus}`);

  if (run.pause) {
    const retry = run.pause.retryAt ? ` · retry at ${formatLocalDateTime(run.pause.retryAt)}` : "";
    lines.push(`pause  ${run.pause.reason}${retry}`);
    if (run.pause.summary) lines.push(`       ${run.pause.summary}`);
  }

  if (run.error) lines.push(`error  ${run.error}`);

  const tasks = progress.tasks ?? [];
  if (tasks.length > 0) {
    lines.push("");
    for (const task of tasks) lines.push(renderTaskLine(task));
  }

  const last = textValue(progress.lastMessage);
  if (last) lines.push(`last  ${last}`);

  return lines.join("\n");
}

function joinStageSegments(segments: string[]): string {
  if (segments.length === 1) return segments[0]!;
  if (segments.length === 2) {
    const separator = segments[1]!.startsWith("batch ") ? " · " : "  ·  ";
    return `${segments[0]}${separator}${segments[1]}`;
  }
  return `${segments[0]} · ${segments.slice(1).join("  ·  ")}`;
}

function renderTaskLine(task: WikiTaskSnapshot): string {
  const attempt = task.attempts !== undefined ? `  [attempt ${task.attempts}]` : "";
  const activity = task.status === "running" ? renderTaskActivity(task) : undefined;
  return `  ${taskIcon(task.status)} ${task.role}  ${task.id}${attempt}${activity ? `  ·  ${activity}` : ""}`;
}

function renderTaskActivity(task: WikiTaskSnapshot): string | undefined {
  if (task.activeTool?.name) return `${task.activeTool.name}…`;
  switch (task.activity) {
    case "responding": return "responding…";
    case "tool": return "tool…";
    case "compacting": return "compacting…";
    default: return undefined;
  }
}

function taskIcon(status: string | undefined): string {
  switch (status) {
    case "queued": return "·";
    case "running": return "◆";
    case "complete": return "✓";
    case "incomplete": return "◐";
    case "failed": return "✗";
    default: return "·";
  }
}

function formatElapsed(start: string, end: string): string | undefined {
  const created = Date.parse(start);
  const finished = Date.parse(end);
  if (!Number.isFinite(created) || !Number.isFinite(finished) || finished < created) return undefined;
  const totalSeconds = Math.floor((finished - created) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function renderWikiRuns(runs: readonly WikiRunView[]): string {
  if (runs.length === 0) return "Wiki runs: none.";
  return ["Wiki runs", ...runs.map((run) => {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const updated = run.updatedAt ? `${formatLocalDateTime(run.updatedAt)} | ` : "";
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
  const taskId = textValue(event.data?.taskId);
  const taskPart = taskId ? ` ${taskId}` : "";
  return `${prefix}${message}${taskPart}`;
}

export function renderWikiTask(inspection: WikiTaskInspection): string {
  const task = inspection.task;
  const receipt = inspection.receipt;
  const attempts = receipt?.attempts ?? task.attempts ?? 0;
  const attemptLabel = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
  const startedAt = task.startedAt;
  const updatedAt = task.updatedAt;
  const elapsed = startedAt && updatedAt ? formatElapsed(startedAt, updatedAt) : undefined;
  const elapsedPart = elapsed ? `  ·  ${elapsed}` : "";
  const lines: string[] = [
    `Wiki ${inspection.runId}  ·  ${task.id}`,
    `${task.role}  ${task.status}  ·  ${attemptLabel}${elapsedPart}`,
  ];
  const context = renderWikiContextStats(inspection.usage ?? task.usage);
  if (context) lines.push(`context  ${context}`);

  const summary = textValue(receipt?.summary) ?? textValue(task.summary);
  if (summary) {
    lines.push("summary");
    lines.push(`  ${summary}`);
  }

  const coverage = receipt?.coverage;
  if (coverage && coverage.length > 0) {
    lines.push("coverage");
    for (const path of coverage) lines.push(`  ${path}`);
  }

  const gaps = receipt?.gaps;
  if (gaps && gaps.length > 0) {
    lines.push("gaps");
    for (const gap of gaps) {
      const question = textValue(gap.question);
      if (question) lines.push(`  ${question}`);
    }
  }

  const errorMessage = textValue(receipt?.error?.message);
  if (errorMessage) lines.push(`error  ${errorMessage}`);

  const handoffPath = textValue(inspection.handoffPath);
  const handoff = inspection.handoff;
  if (handoffPath) lines.push(`handoff  ${handoffPath}`);
  if (handoff) {
    lines.push("────────────────────────────────");
    const bodyLines = handoff.split(/\r?\n/);
    lines.push(...bodyLines.slice(0, 80));
    if (bodyLines.length > 80) {
      const size = Buffer.byteLength(handoff, "utf8");
      lines.push(`… (handoff continues; ${size} at ${handoffPath ?? "unknown"})`);
    }
  }

  return lines.join("\n");
}

export function renderWikiTaskProcess(inspection: WikiTaskInspection): string {
  const header = `Wiki ${inspection.runId}  ·  ${inspection.task.id}  ·  process`;
  const history = inspection.history;
  if (!inspection.processAvailable || !history || history.length === 0) {
    const lines = [header, "process  unavailable for this task"];
    const handoffPath = textValue(inspection.handoffPath);
    if (handoffPath) lines.push(`handoff  ${handoffPath}`);
    return lines.join("\n");
  }
  const lines = [header];
  for (const entry of history) lines.push(renderHistoryLine(entry));
  return lines.join("\n");
}

export function renderWikiContextStats(usage: WikiContextStats | undefined): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.turns !== undefined) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.toolCalls !== undefined) parts.push(`${usage.toolCalls} tools`);
  if (usage.input !== undefined) parts.push(`↑${formatTokenCount(usage.input)}`);
  if (usage.output !== undefined) parts.push(`↓${formatTokenCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
  const context = formatContextWindow(usage);
  if (context) parts.push(context);
  if (usage.cost !== undefined && usage.cost > 0) parts.push(formatCost(usage.cost));
  if (usage.model) parts.push(usage.model);
  return parts.length > 0 ? parts.join("  ") : undefined;
}

function formatContextWindow(usage: WikiContextStats): string | undefined {
  if (usage.contextTokens === undefined && usage.contextWindow === undefined && usage.contextPercent === undefined) {
    return undefined;
  }
  const used = usage.contextTokens !== undefined ? formatTokenCount(usage.contextTokens) : "?";
  const window = usage.contextWindow !== undefined ? formatTokenCount(usage.contextWindow) : undefined;
  const percent = usage.contextPercent !== undefined ? ` ${Math.round(usage.contextPercent)}%` : "";
  return window ? `ctx ${used}/${window}${percent}` : `ctx ${used}${percent}`;
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}

function renderHistoryLine(entry: WikiHistoryEntry): string {
  const text = entry.text.trim();
  return `${historyPrefix(entry)}  ${text}`.trimEnd();
}

function historyPrefix(entry: WikiHistoryEntry): string {
  if (entry.kind === "toolCall") return `→ ${entry.toolName ?? "tool"}`;
  if (entry.kind === "toolResult") return "tool";
  if (entry.kind === "error") return "error";
  if (entry.role === "user") return "user";
  return "text";
}

export function wikiCliHelp(): string {
  return [
    "Usage:",
    "  /wiki [focus]",
    "  /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]",
    "  /wiki source add link <local-path> [--name <name>] [--workspace <dir>]",
    "  /wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]",
    "  /wiki regenerate [focus]",
    "  /wiki status [run-id] [task-id] [--process]",
    "  /wiki runs",
    "  /wiki pause",
    "  /wiki resume [run-id]",
    "  /wiki cancel [run-id]",
  ].join("\n");
}

function parseInit(values: string[]): Extract<WikiCliCommand, { action: "init" }> {
  let workspace: string | undefined;
  let language: "zh" | "en" = "zh";
  let languageSet = false;
  let defaultSourceIgnores = true;
  let ignoresSet = false;
  const exclude: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--lang") {
      if (languageSet) throw new Error("--lang may be specified only once");
      const selected = optionValue(values, ++index, "--lang");
      if (selected !== "zh" && selected !== "en") throw new Error("--lang must be zh or en");
      language = selected;
      languageSet = true;
    } else if (value === "--exclude") {
      exclude.push(optionValue(values, ++index, "--exclude"));
    } else if (value === "--no-default-ignores") {
      if (ignoresSet) throw new Error("--no-default-ignores may be specified only once");
      defaultSourceIgnores = false;
      ignoresSet = true;
    } else if (value.startsWith("--")) {
      throw new Error(`Unknown /wiki init option: ${value}`);
    } else if (workspace === undefined) {
      workspace = value;
    } else {
      throw new Error("Usage: /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]");
    }
  }
  return { action: "init", ...(workspace ? { workspace } : {}), language, exclude, defaultSourceIgnores };
}

function parseSource(values: string[]): Extract<WikiCliCommand, { action: "source-add" }> {
  if (values[0] !== "add" || (values[1] !== "link" && values[1] !== "clone") || !values[2]) {
    throw new Error("Usage: /wiki source add link <local-path> | clone <url>");
  }
  const kind = values[1];
  const target = values[2];
  let name: string | undefined;
  let workspace: string | undefined;
  let ref: string | undefined;
  for (let index = 3; index < values.length; index += 1) {
    const option = values[index]!;
    if (option === "--name") {
      if (name !== undefined) throw new Error("--name may be specified only once");
      name = optionValue(values, ++index, "--name");
    } else if (option === "--workspace") {
      if (workspace !== undefined) throw new Error("--workspace may be specified only once");
      workspace = optionValue(values, ++index, "--workspace");
    } else if (option === "--ref" && kind === "clone") {
      if (ref !== undefined) throw new Error("--ref may be specified only once");
      ref = optionValue(values, ++index, "--ref");
    } else {
      throw new Error(`Unknown /wiki source add ${kind} option: ${option}`);
    }
  }
  const common = { action: "source-add" as const, kind, ...(name ? { name } : {}), ...(workspace ? { workspace } : {}) };
  return kind === "link" ? { ...common, kind, localPath: target } : { ...common, kind, url: target, ...(ref ? { ref } : {}) };
}

function optionValue(values: string[], index: number, option: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
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
  if (value && !SAFE_ID.test(value)) {
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
