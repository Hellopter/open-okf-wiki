import type { AgentMessage, AgentToolCall } from "@okf-wiki/contract";
import { CircleAlert, Loader2Icon } from "lucide-react";
import { type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { MarkdownDocument } from "../../shared/MarkdownDocument";
import { agentToolCallToViewModel } from "./adapters/tool-call";
import type { ToolNameLabels } from "./adapters/tool-labels";
import type { ToolItemVM } from "./adapters/types";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { ToolExecutionGroup } from "./ToolExecutionGroup";

export type AssistantTurnLabels = {
  thinking: string;
  thought: string;
  thinkingElapsed?: string;
  generating?: string;
  toolInput: string;
  toolOutput: string;
  toolError: string;
  openRun: string;
  toolCallsSummary: string;
  copy?: string;
  copied?: string;
  toolNames: ToolNameLabels;
};

export type AssistantTurnProps = {
  message: AgentMessage;
  labels: AssistantTurnLabels;
  onOpenRun?: (runId: string) => void;
  className?: string;
};

function toolsToViewModels(tools: AgentToolCall[], labels: ToolNameLabels): ToolItemVM[] {
  return tools.map((tool) => agentToolCallToViewModel(tool, labels));
}

function ToolGroup({
  tools,
  labels,
  onOpenRun,
}: {
  tools: AgentToolCall[];
  labels: AssistantTurnLabels;
  onOpenRun?: (runId: string) => void;
}) {
  if (tools.length === 0) return null;
  const items = toolsToViewModels(tools, labels.toolNames);
  return (
    <ToolExecutionGroup
      items={items}
      inputLabel={labels.toolInput}
      outputLabel={labels.toolOutput}
      errorLabel={labels.toolError}
      openRunLabel={labels.openRun}
      toolCallsSummaryLabel={labels.toolCallsSummary}
      copyLabel={labels.copy}
      copiedLabel={labels.copied}
      onOpenRun={onOpenRun}
    />
  );
}

/**
 * Denoised assistant turn: thinking → tools → prose, no Bot header / forced timestamp.
 */
export function AssistantTurn({
  message,
  labels,
  onOpenRun,
  className,
}: AssistantTurnProps) {
  const streaming = message.status === "streaming";
  const mdMode = streaming ? "streaming" : "static";

  const thinkingProps = {
    streamingLabel: labels.thinking,
    doneLabel: labels.thought,
    elapsedLabel: labels.thinkingElapsed,
  };

  const parts = message.parts;
  const hasTextPart = parts?.some((part) => part.type === "text" && part.text) ?? false;
  // Visible prose: text parts or top-level content (content-fallback / no-parts path).
  const hasVisibleText = hasTextPart || Boolean(message.content);
  const hasThinkingParts = parts?.some((part) => part.type === "thinking") ?? false;
  // Suppress "Generating…" when thinking or tools already provide visible activity.
  const showGenerating =
    streaming &&
    !hasVisibleText &&
    !message.thinking &&
    !(message.tools?.length) &&
    !hasThinkingParts;
  let body: ReactNode;

  if (parts && parts.length > 0) {
    const toolsById = new Map((message.tools ?? []).map((tool) => [tool.id, tool] as const));
    const nodes: ReactNode[] = [];
    let toolBuffer: AgentToolCall[] = [];
    let textIdx = 0;
    let toolGroupIdx = 0;
    let thinkingPartIdx = 0;
    const renderedToolIds = new Set<string>();
    const lastThinkingPartIndex = (() => {
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]?.type === "thinking") return i;
      }
      return -1;
    })();
    // Caret tracks the last text part with content, not merely the last part in the array
    // (which may be a tool after prose has already started streaming).
    const lastTextPartWithContentIndex = (() => {
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part?.type === "text" && part.text) return i;
      }
      return -1;
    })();

    // Top-level thinking only when parts have no thinking entries (parts-first otherwise).
    if (message.thinking && !hasThinkingParts) {
      nodes.push(
        <ThinkingDisclosure
          key="thinking-top-level"
          text={message.thinking}
          status={message.thinkingStatus}
          {...thinkingProps}
        />,
      );
    }

    const flushTools = () => {
      if (toolBuffer.length === 0) return;
      const key = `tools-${toolGroupIdx++}`;
      nodes.push(
        <ToolGroup key={key} tools={toolBuffer} labels={labels} onOpenRun={onOpenRun} />,
      );
      toolBuffer = [];
    };

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]!;
      if (part.type === "thinking") {
        flushTools();
        // Only the last thinking part stays "streaming"; earlier parts are always done.
        // Render empty thinking while streaming so the live row appears immediately.
        const thinkingStatus =
          partIndex === lastThinkingPartIndex && message.thinkingStatus === "streaming"
            ? "streaming"
            : "done";
        if (part.thinking || thinkingStatus === "streaming") {
          nodes.push(
            <ThinkingDisclosure
              key={`thinking-part-${thinkingPartIdx++}`}
              text={part.thinking || ""}
              status={thinkingStatus}
              {...thinkingProps}
            />,
          );
        }
        continue;
      }
      if (part.type === "text") {
        flushTools();
        if (part.text) {
          nodes.push(
            <span key={`text-${textIdx++}`} className="relative inline-block w-full">
              <MarkdownDocument content={part.text} mode={mdMode} />
              {streaming && partIndex === lastTextPartWithContentIndex ? (
                <span
                  className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 animate-pulse bg-foreground"
                  aria-hidden
                />
              ) : null}
            </span>,
          );
        }
        continue;
      }
      if (part.type === "tool") {
        const tool = toolsById.get(part.toolId);
        if (tool && !renderedToolIds.has(tool.id)) {
          toolBuffer.push(tool);
          renderedToolIds.add(tool.id);
        }
      }
    }
    flushTools();

    const remaining = (message.tools ?? []).filter((tool) => !renderedToolIds.has(tool.id));
    if (remaining.length > 0) {
      nodes.push(
        <ToolGroup key="tools-remaining" tools={remaining} labels={labels} onOpenRun={onOpenRun} />,
      );
    }

    if (!hasTextPart && message.content) {
      // Append prose after thinking/tools — coherent fallback when no text parts exist.
      nodes.push(
        <span key="content-fallback" className="relative inline-block w-full">
          <MarkdownDocument content={message.content} mode={mdMode} />
          {streaming ? (
            <span
              className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 animate-pulse bg-foreground"
              aria-hidden
            />
          ) : null}
        </span>,
      );
    }

    body = <>{nodes}</>;
  } else {
    body = (
      <>
        {message.thinking ? (
          <ThinkingDisclosure
            text={message.thinking}
            status={message.thinkingStatus}
            {...thinkingProps}
          />
        ) : null}
        {message.content ? (
          <span className="relative inline-block w-full">
            <MarkdownDocument content={message.content} mode={mdMode} />
            {streaming ? (
              <span
                className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 animate-pulse bg-foreground"
                aria-hidden
              />
            ) : null}
          </span>
        ) : null}
        <ToolGroup tools={message.tools ?? []} labels={labels} onOpenRun={onOpenRun} />
      </>
    );
  }

  return (
    <div
      className={cn("flex w-full min-w-0 flex-col gap-2.5", className)}
      data-slot="assistant-turn"
    >
      {showGenerating ? (
        <p
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2Icon className="size-3 animate-spin" aria-hidden />
          <span>{labels.generating ?? "…"}</span>
        </p>
      ) : null}
      {body}
      {message.errorText ? (
        <Alert variant="destructive" className="max-w-3xl">
          <CircleAlert />
          <AlertDescription>{message.errorText}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
