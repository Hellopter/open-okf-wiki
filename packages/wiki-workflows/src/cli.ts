import type {
  WikiActivityEntry,
  WikiAgentInspection,
  WikiAgentStatus,
  WikiAgentTarget,
  WikiContextStats,
  WikiRunEvent,
  WikiRunProgress,
  WikiRunView,
  WikiTaskSnapshot,
} from "./producer-types.js";
import { formatLocalDateTime } from "./time-format.js";

export type WikiCliCommand =
  | { action: "run"; focus?: string; regenerate: boolean }
  | { action: "init"; workspace?: string; language: "zh" | "en"; exclude: string[]; defaultSourceIgnores: boolean }
  | { action: "source-add"; kind: "link"; localPath: string; name?: string; workspace?: string }
  | { action: "source-add"; kind: "clone"; url: string; ref?: string; name?: string; workspace?: string }
  | { action: "status"; runId?: string; target?: WikiAgentTarget; process?: boolean }
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
const BATCH_TARGET = /^batch-(\d+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

function parseStatus(values: string[]): Extract<WikiCliCommand, { action: "status" }> {
  let runId: string | undefined;
  let target: WikiAgentTarget | undefined;
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
    if (target === undefined) {
      if (value !== "lead" && !BATCH_TARGET.test(value)) throw new Error("Wiki agent target must be lead or batch-N/task-id");
      target = parseAgentTarget(value);
      continue;
    }
    extra = true;
  }
  if (extra || (process && !target) || (target && !runId)) {
    throw new Error("Usage: /wiki status [run-id] [lead|batch-N/task-id] [--process]");
  }
  return {
    action: "status",
    ...(runId ? { runId } : {}),
    ...(target ? { target } : {}),
    ...(process ? { process } : {}),
  };
}

function parseAgentTarget(value: string): WikiAgentTarget {
  if (value === "lead") return { kind: "lead" };
  const match = BATCH_TARGET.exec(value);
  if (!match) throw new Error("Wiki agent target must be lead or batch-N/task-id");
  return { kind: "task", batch: Number(match[1]), taskId: match[2]! };
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
  const currentBatch = progress.currentBatch;
  const batch = currentBatch?.batch;
  const completed = currentBatch?.completed;
  const total = currentBatch?.total;
  if (batch !== undefined) stageSegments.push(`batch ${batch}`);
  if (completed !== undefined && total !== undefined) {
    const running = currentBatch?.tasks.filter((task) => task.status === "running").length ?? 0;
    stageSegments.push(`${completed}/${total} done${running > 0 ? `, ${running} running` : ""}`);
  }
  lines.push(stageSegments.join(" · "));

  if (run.focus) lines.push(`focus  ${run.focus}`);

  if (run.pause) {
    const retry = run.pause.retryAt ? ` · retry at ${formatLocalDateTime(run.pause.retryAt)}` : "";
    lines.push(`pause  ${run.pause.reason}${retry}`);
    if (run.pause.summary) lines.push(`       ${run.pause.summary}`);
  }

  if (run.error) lines.push(`error  ${run.error}`);

  const tasks = currentBatch?.tasks ?? [];
  if (tasks.length > 0) {
    lines.push("");
    for (const task of tasks) lines.push(renderTaskLine(task));
  }

  const last = textValue(progress.lastMessage);
  if (last) lines.push(`last  ${last}`);

  return lines.join("\n");
}

function renderTaskLine(task: WikiTaskSnapshot): string {
  const attempt = task.attempts !== undefined ? `  [attempt ${task.attempts}]` : "";
  const activity = task.status === "running" ? renderTaskActivity(task) : undefined;
  return `  ${wikiAgentStatusPresentation(task.status).icon} ${task.role}  ${task.id}${attempt}${activity ? `  ·  ${activity}` : ""}`;
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

export type WikiTextRole = "primary" | "label" | "muted" | "accent" | "success" | "warning" | "error";

export interface WikiTextSpan {
  text: string;
  role: WikiTextRole;
  emphasis?: boolean;
}

export type WikiTextLine = readonly WikiTextSpan[];

export interface WikiStatusPresentation {
  icon: string;
  role: WikiTextRole;
}

export function wikiAgentStatusPresentation(status: WikiAgentStatus): WikiStatusPresentation {
  switch (status) {
    case "running": return { icon: "◆", role: "accent" };
    case "complete": return { icon: "✓", role: "success" };
    case "incomplete":
    case "retrying": return { icon: "◐", role: "warning" };
    case "failed": return { icon: "✗", role: "error" };
    case "queued": return { icon: "·", role: "muted" };
    case "cancelled": return { icon: "○", role: "muted" };
  }
}

export function renderWikiAgentLines(
  inspection: WikiAgentInspection,
  tab: "overview" | "process" | "output" = "overview",
): WikiTextLine[] {
  const agent = inspection.agent;
  const id = agent.target.kind === "lead" ? "lead" : `batch-${agent.target.batch}/${agent.target.taskId}`;
  const header = `Wiki ${inspection.runId}  ·  ${id}`;
  if (tab === "process") {
    const lines: WikiTextLine[] = [[
      textSpan(header, "primary", true),
      textSpan("  ·  process", "muted"),
    ]];
    if (inspection.process.length === 0) lines.push([
      textSpan("process  ", "label"),
      textSpan("unavailable for this agent", "muted"),
    ]);
    else for (const entry of inspection.process) {
      if (entry.kind === "tool" && !entry.completed) continue;
      lines.push(processEntryLine(entry));
    }
    return lines;
  }
  if (tab === "output") {
    return [
      [textSpan(header, "primary", true)],
      [textSpan("output", "label")],
      ...textLines(inspection.handoff ?? agent.summary ?? "  No output yet.", inspection.handoff || agent.summary ? "primary" : "muted"),
    ];
  }
  const lines: WikiTextLine[] = [
    [textSpan(header, "primary", true)],
    [
      textSpan(`${agent.role}  `, "primary"),
      textSpan(agent.status, wikiAgentStatusPresentation(agent.status).role, true),
      textSpan(`  ·  ${agent.activity.replaceAll("_", " ")}  ·  attempt ${agent.attempt}`, "muted"),
    ],
  ];
  if (agent.activeTools.length) lines.push(fieldLine("tools", agent.activeTools.map((tool) => tool.name).join(", "), "accent"));
  if (agent.lastHeartbeatAt) lines.push(fieldLine("heartbeat", formatLocalDateTime(agent.lastHeartbeatAt), "muted"));
  if (agent.lastActivityAt) lines.push(fieldLine("Pi activity", formatLocalDateTime(agent.lastActivityAt), "muted"));
  if (agent.deadlineAt) lines.push(fieldLine("deadline", formatLocalDateTime(agent.deadlineAt), "muted"));
  const stats = renderWikiContextStats(agent.usage);
  if (stats) lines.push(fieldLine("context", stats, "primary"));
  if (agent.summary) {
    lines.push([textSpan("summary", "label")]);
    lines.push(...textLines(`  ${agent.summary}`, "primary"));
  }
  return lines;
}

export function renderWikiAgent(
  inspection: WikiAgentInspection,
  tab: "overview" | "process" | "output" = "overview",
): string {
  return renderWikiAgentLines(inspection, tab)
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n");
}

function textSpan(text: string, role: WikiTextRole, emphasis?: boolean): WikiTextSpan {
  return emphasis ? { text, role, emphasis } : { text, role };
}

function textLines(text: string, role: WikiTextRole): WikiTextLine[] {
  return text.split("\n").map((line) => [textSpan(line, role)]);
}

function fieldLine(label: string, value: string, valueRole: WikiTextRole): WikiTextLine {
  return [textSpan(`${label}  `, "label"), textSpan(value, valueRole)];
}

function processEntryLine(entry: WikiActivityEntry): WikiTextLine {
  const failed = entry.severity === "error";
  const role: WikiTextRole = failed ? "error" : entry.severity === "warning" ? "warning" : entry.completed ? "success" : "accent";
  const duration = entry.durationMs === undefined ? "" : ` · ${formatDuration(entry.durationMs)}`;
  if (entry.kind === "tool") {
    const name = entry.toolName ?? "tool";
    const detail = failed ? entry.message : entry.summary;
    return [
      textSpan(`${failed ? "✗" : "✓"} `, role),
      textSpan(name, "primary"),
      ...(duration ? [textSpan(duration, "muted")] : []),
      ...(detail ? [textSpan(`  ${detail}`, failed ? "error" : "muted")] : []),
    ];
  }
  return [
    textSpan(`${entry.completed ? "✓" : "◆"} `, role),
    textSpan(entry.kind, role),
    ...(duration ? [textSpan(duration, "muted")] : []),
    textSpan(`  ${entry.message}`, failed || entry.severity === "warning" ? role : "primary"),
  ];
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
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

export function wikiCliHelp(): string {
  return [
    "Usage:",
    "  /wiki [focus]",
    "  /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]",
    "  /wiki source add link <local-path> [--name <name>] [--workspace <dir>]",
    "  /wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]",
    "  /wiki regenerate [focus]",
    "  /wiki status [run-id] [lead|batch-N/task-id] [--process]",
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
