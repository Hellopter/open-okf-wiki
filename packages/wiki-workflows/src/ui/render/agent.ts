import { truncateToWidth } from "@earendil-works/pi-tui";
import type { WikiNode, WikiNodeHistoryEntry, WikiNodeMetrics, WikiRunSnapshot } from "../../workflow-types.js";
import {
  activityText,
  asText,
  fitLine,
  formatContext,
  formatCount,
  formatDuration,
  formatNodeDuration,
  formatTimestamp,
  safeJson,
  stageLabel,
  STATUS_COLOR,
  STATUS_ICON,
  wrapLines,
  type WikiUiTheme,
} from "../format.js";
import type { NavigatorState } from "../state.js";
import { uiStrings, type WikiUiLanguage } from "../strings.js";
import { renderRunHeader } from "./chrome.js";

type AttemptView = Pick<WikiNode, "attempt" | "startedAt" | "finishedAt" | "result" | "output" | "history" | "error" | "metrics">;

export function renderAgentView(
  state: NavigatorState,
  run: WikiRunSnapshot,
  node: WikiNode,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const header = renderRunHeader(run, width, theme);
  const attempt = attemptView(node, state.selectedAttempt);
  const bodyRows = Math.max(4, rows - header.length);
  if (!state.pagerOpen) {
    return [...header, ...renderCompact(node, attempt, width, theme, bodyRows, language)];
  }
  return [...header, ...renderPager(state, node, attempt, width, theme, bodyRows, language)];
}

function renderCompact(
  node: WikiNode,
  attempt: AttemptView,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const s = uiStrings(language);
  const attemptSuffix = attempt.attempt !== node.attempt ? s.agentArchived : "";
  const lines = [
    theme.bold(s.agentTitle(asText(node.label))),
    fitLine(theme.fg(STATUS_COLOR[node.status], `${STATUS_ICON[node.status]} ${asText(node.status)} | ${s.agentAttempt(attempt.attempt, attemptSuffix)} | ${stageLabel(node.kind)}`), width),
  ];
  if (node.activity.message || node.activity.state !== "idle") {
    lines.push(fitLine(theme.fg("accent", asText(activityText(node))), width));
  }
  lines.push("");
  lines.push(...renderExecutionFooter(node, attempt, width, theme, language));
  if (attempt.error) {
    lines.push(theme.bold(s.failure));
    lines.push(fitLine(theme.fg("error", asText(attempt.error.message)), width));
  } else if (attempt.output) {
    lines.push(theme.bold(s.latestOutput));
    lines.push(...wrapLines(asText(attempt.output), width).slice(0, 4).map((line) => theme.fg("muted", line)));
  } else if (attempt.result !== undefined) {
    lines.push(theme.bold(resultLabel(node.kind, language)));
    lines.push(...wrapLines(typeof attempt.result === "string" ? asText(attempt.result) : safeJson(attempt.result), width).slice(0, 4).map((line) => theme.fg("muted", line)));
  } else {
    lines.push(theme.fg("muted", s.noCompletedOutput));
  }
  lines.push("");
  lines.push(theme.fg("dim", `  ${s.compact} · ${s.compactHint}`));
  return lines.slice(0, rows).map((line) => fitLine(line, width));
}

function renderPager(
  state: NavigatorState,
  node: WikiNode,
  attempt: AttemptView,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const s = uiStrings(language);
  const content = renderAgentTranscript(node, attempt, width, theme, language);
  const execution = renderExecutionFooter(node, attempt, width, theme, language);
  const transcriptRows = Math.max(2, rows - execution.length - 1);
  const viewport = Math.max(1, transcriptRows);
  const maxScroll = Math.max(0, content.length - viewport);
  // followOutput pins to end; otherwise clamp and write back a real scroll position.
  const scroll = state.applyPagerScroll(maxScroll);
  const main = content.slice(scroll, scroll + viewport);
  const range = `${scroll + 1}-${Math.min(scroll + viewport, content.length)}/${content.length}`;
  const followLabel = state.followOutput ? ` ${s.follow}` : "";
  while (main.length < viewport) main.push("");
  main.push(theme.fg("dim", `  ${range}${followLabel}`));
  main.push(...execution);
  return main.map((line) => fitLine(line, width));
}

function renderAgentTranscript(
  node: WikiNode,
  attempt: AttemptView,
  width: number,
  theme: WikiUiTheme,
  language?: WikiUiLanguage,
): string[] {
  const s = uiStrings(language);
  const attemptSuffix = attempt.attempt !== node.attempt ? s.agentArchived : "";
  const lines = [theme.bold(s.agentTitle(asText(node.label)))];
  lines.push(truncateToWidth(
    theme.fg(STATUS_COLOR[node.status], `${STATUS_ICON[node.status]} ${asText(node.status)} | ${s.agentAttempt(attempt.attempt, attemptSuffix)} | ${stageLabel(node.kind)}`),
    width,
    "",
    true,
  ));
  if (node.activity.message || node.activity.state !== "idle") {
    lines.push(truncateToWidth(theme.fg("accent", asText(activityText(node))), width, "", true));
  }
  lines.push("");
  lines.push(theme.bold(s.messagesTitle));
  if (attempt.history?.length) {
    for (const entry of attempt.history) lines.push(...renderHistoryEntry(entry, width, theme));
  } else {
    lines.push(theme.fg("muted", s.noMessagesYet));
  }
  if (attempt.output) {
    lines.push("");
    lines.push(theme.bold(s.latestAssistantOutput));
    lines.push(...renderObject(attempt.output, width, theme));
  }
  lines.push("");
  if (attempt.error) {
    lines.push(theme.bold(s.failure));
    lines.push(...renderObject(s.errorPrefix(asText(attempt.error.message)), width, {
      ...theme,
      fg: (_color, text) => theme.fg("error", text),
    }));
    if (attempt.error.requiredSubmissionTool) {
      lines.push(...renderObject(s.requiredSubmission(asText(attempt.error.requiredSubmissionTool)), width, {
        ...theme,
        fg: (_color, text) => theme.fg("warning", text),
      }));
    }
  } else {
    lines.push(theme.bold(resultLabel(node.kind, language)));
    lines.push(...renderObject(attempt.result ?? s.noNodeResult, width, theme));
  }
  return lines;
}

function renderExecutionFooter(
  node: WikiNode,
  attempt: AttemptView,
  width: number,
  theme: WikiUiTheme,
  language?: WikiUiLanguage,
): string[] {
  const s = uiStrings(language);
  const metrics = attempt.metrics ?? emptyMetrics();
  const context = formatContext(metrics.contextTokens, metrics.contextWindow, metrics.contextEstimated);
  const timing = attempt.startedAt ? `Duration: ${formatNodeDuration(attempt.startedAt, attempt.finishedAt)}` : "";
  const usage = [
    metrics.inputTokens ? `in ${formatCount(metrics.inputTokens)}` : "",
    metrics.outputTokens ? `out ${formatCount(metrics.outputTokens)}` : "",
    metrics.cacheReadTokens ? `cache ${formatCount(metrics.cacheReadTokens)}` : "",
  ].filter(Boolean).join(" | ");
  const recovery = [
    metrics.compactions ? `compactions ${metrics.compactions}` : "",
    metrics.autoRetries ? `auto retries ${metrics.autoRetries}` : "",
    node.activity.retryDelayMs ? `backoff ${formatDuration(node.activity.retryDelayMs)}` : "",
  ].filter(Boolean).join(" | ");
  const details = [
    metrics.model ? `Model: ${asText(metrics.model)}` : "",
    usage,
    recovery,
    metrics.cost ? `Cost: $${metrics.cost.toFixed(4)}` : "",
  ].filter(Boolean).join(" | ");
  const summary = [s.execution, context ? `Context: ${context}` : "", timing].filter(Boolean).join(" | ");
  return [
    truncateToWidth(theme.bold(summary), width, "", true),
    truncateToWidth(theme.fg("muted", details || s.noExecutionMetrics), width, "", true),
  ];
}

function renderHistoryEntry(entry: WikiNodeHistoryEntry, width: number, theme: WikiUiTheme): string[] {
  const label = historyLabel(entry);
  const color = entry.isError || entry.kind === "error" ? "error" : entry.kind === "tool_call" ? "accent" : "muted";
  const timestamp = historyNeedsTimestamp(entry) ? `${formatTimestamp(entry.at)} ` : "";
  const lines = [truncateToWidth(theme.fg(color, `  ${timestamp}${label}`), width, "", true)];
  const text = entry.kind === "message" || entry.kind === "error"
    ? asText(entry.text) || "(no text)"
    : asText(historySummary(entry));
  lines.push(...wrapLines(text, Math.max(12, width - 4)).map((line) => truncateToWidth(theme.fg(color, `    ${line}`), width, "", true)));
  return lines;
}

function historyLabel(entry: WikiNodeHistoryEntry): string {
  const target = entry.target ? ` ${asText(entry.target)}` : "";
  if (entry.kind === "message") return "assistant";
  if (entry.kind === "tool_call") return `tool ${asText(entry.toolName) || "call"}${target}`;
  if (entry.kind === "tool_result") return `tool ${asText(entry.toolName) || "result"}${target}`;
  return entry.toolName ? `tool ${asText(entry.toolName)} error${target}` : "agent error";
}

function historySummary(entry: WikiNodeHistoryEntry): string {
  if (entry.summary) return asText(entry.summary);
  if (entry.kind === "tool_call") return "Running";
  if (entry.target) return "Completed";
  return entry.isError ? "Tool failed" : "Completed";
}

function historyNeedsTimestamp(entry: WikiNodeHistoryEntry): boolean {
  return entry.kind === "message" || (entry.kind === "error" && !entry.toolName);
}

function attemptView(node: WikiNode, selectedAttempt: number | undefined): AttemptView {
  if (selectedAttempt !== undefined && selectedAttempt !== node.attempt) {
    const archived = (node.attemptHistory ?? []).find((item) => item.attempt === selectedAttempt);
    if (archived) return archived;
  }
  return node;
}

function resultLabel(kind: WikiNode["kind"], language?: WikiUiLanguage): string {
  const s = uiStrings(language);
  if (kind === "research") return s.markdownHandoff;
  if (kind === "synthesis" || kind === "review") return s.controlSubmission;
  return s.nodeResult;
}

function renderObject(value: unknown, width: number, theme: WikiUiTheme): string[] {
  const text = typeof value === "string" ? asText(value) : safeJson(value);
  return wrapLines(text, width).map((line) => truncateToWidth(theme.fg("muted", line), width, "", true));
}

function emptyMetrics(): WikiNodeMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    compactions: 0,
    autoRetries: 0,
  };
}

export function attemptNumbers(node: WikiNode): number[] {
  return [...new Set([...(node.attemptHistory ?? []).map((item) => item.attempt), node.attempt ?? 0])]
    .filter((attempt) => attempt > 0)
    .sort((left, right) => left - right);
}
