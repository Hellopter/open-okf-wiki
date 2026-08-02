import type { AgentMessage, AgentToolCall } from "@okf-wiki/contract";
import { BotIcon, CircleAlert, WorkflowIcon } from "lucide-react";
import { type ReactNode } from "react";
import {
  agentToolCallToViewModel,
  describeRunStatus,
  StatusBadge,
  ThinkingDisclosure,
  ToolExecutionGroup,
  type ToolItemVM,
} from "@/components/agent-ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { useI18n, type MessageTree } from "../i18n";
import { MarkdownDocument } from "../shared/MarkdownDocument";
import type { SessionRunLink } from "./session-run-links";

function runStateLabel(run: SessionRunLink, labels: Record<string, string>): string {
  return labels[run.state] ?? run.state.replaceAll("_", " ");
}

function toolNameLabels(t: MessageTree) {
  return {
    wikiProduce: t.workbench.toolNames.wiki_produce,
    status: {
      pending: t.workbench.toolPending,
      running: t.workbench.toolRunning,
      done: t.workbench.toolCompleted,
      error: t.workbench.toolFailed,
    },
  };
}

function toolsToViewModels(tools: AgentToolCall[], t: MessageTree): ToolItemVM[] {
  const labels = toolNameLabels(t);
  return tools.map((tool) => agentToolCallToViewModel(tool, labels));
}

function ToolGroup({
  tools,
  onOpenRun,
}: {
  tools: AgentToolCall[];
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
  if (tools.length === 0) return null;
  const items = toolsToViewModels(tools, t);
  return (
    <ToolExecutionGroup
      items={items}
      inputLabel={t.workbench.toolInput}
      outputLabel={t.workbench.toolOutput}
      errorLabel={t.workbench.toolError}
      openRunLabel={t.workbench.openRun}
      toolCallsSummaryLabel={t.workbench.toolCallsSummary}
      copyLabel={t.workbench.copy}
      copiedLabel={t.workbench.copied}
      onOpenRun={onOpenRun}
    />
  );
}

function AssistantContent({
  message,
  onOpenRun,
}: {
  message: AgentMessage;
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
  const streaming = message.status === "streaming";
  const mdMode = streaming ? "streaming" : "static";

  const thinkingBlock =
    message.thinking ? (
      <ThinkingDisclosure
        text={message.thinking}
        status={message.thinkingStatus}
        streamingLabel={t.workbench.thinking}
        doneLabel={t.workbench.thought}
      />
    ) : null;

  const parts = message.parts;
  if (parts && parts.length > 0) {
    const toolsById = new Map((message.tools ?? []).map((tool) => [tool.id, tool] as const));
    const nodes: ReactNode[] = [];
    let toolBuffer: AgentToolCall[] = [];
    let textIdx = 0;
    let toolGroupIdx = 0;
    let thinkingPartIdx = 0;
    const renderedToolIds = new Set<string>();
    const hasThinkingParts = parts.some((part) => part.type === "thinking");
    const lastThinkingPartIndex = (() => {
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]?.type === "thinking") return i;
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
          streamingLabel={t.workbench.thinking}
          doneLabel={t.workbench.thought}
        />,
      );
    }

    const flushTools = () => {
      if (toolBuffer.length === 0) return;
      const key = `tools-${toolGroupIdx++}`;
      nodes.push(<ToolGroup key={key} tools={toolBuffer} onOpenRun={onOpenRun} />);
      toolBuffer = [];
    };

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]!;
      if (part.type === "thinking") {
        flushTools();
        if (part.thinking) {
          const thinkingStatus =
            message.thinkingStatus === "streaming" || partIndex === lastThinkingPartIndex
              ? message.thinkingStatus
              : "done";
          nodes.push(
            <ThinkingDisclosure
              key={`thinking-part-${thinkingPartIdx++}`}
              text={part.thinking}
              status={thinkingStatus}
              streamingLabel={t.workbench.thinking}
              doneLabel={t.workbench.thought}
            />,
          );
        }
        continue;
      }
      if (part.type === "text") {
        flushTools();
        if (part.text) {
          nodes.push(
            <MarkdownDocument key={`text-${textIdx++}`} content={part.text} mode={mdMode} />,
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
      nodes.push(<ToolGroup key="tools-remaining" tools={remaining} onOpenRun={onOpenRun} />);
    }

    const hasTextPart = parts.some((part) => part.type === "text" && part.text);
    if (!hasTextPart && message.content) {
      // Insert content after any leading thinking, before other parts.
      const insertAt = nodes.length > 0 && message.thinking && !hasThinkingParts ? 1 : 0;
      nodes.splice(
        insertAt,
        0,
        <MarkdownDocument key="content-fallback" content={message.content} mode={mdMode} />,
      );
    }

    // Parts own chronological order — do not hoist top-level thinking ahead of them.
    return <>{nodes}</>;
  }

  return (
    <>
      {thinkingBlock}
      {message.content ? <MarkdownDocument content={message.content} mode={mdMode} /> : null}
      <ToolGroup tools={message.tools ?? []} onOpenRun={onOpenRun} />
    </>
  );
}

function SessionRunLinks({
  runs,
  onOpenRun,
}: {
  runs: SessionRunLink[];
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  if (runs.length === 0) return null;
  return (
    <Marker variant="border" className="shrink-0 px-4 py-2 md:px-6" data-testid="session-run-links">
      <MarkerIcon>
        <WorkflowIcon />
      </MarkerIcon>
      <MarkerContent className="flex flex-1 flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t.workbench.sessionRuns}</span>
        {runs.map((run) => {
          const descriptor = describeRunStatus(run.state);
          const label = runStateLabel(run, t.workbench.runStates);
          return (
            <Button key={run.runId} size="sm" variant="outline" onClick={() => onOpenRun(run.runId)}>
              <WorkflowIcon data-icon="inline-start" />
              <span className="font-mono">{run.runId.slice(0, 12)}</span>
              <StatusBadge descriptor={descriptor}>{label}</StatusBadge>
            </Button>
          );
        })}
      </MarkerContent>
    </Marker>
  );
}

function TranscriptRow({
  message,
  onOpenRun,
}: {
  message: AgentMessage;
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
  if (message.role === "system") {
    return (
      <Marker variant="separator">
        <MarkerContent>{message.content}</MarkerContent>
      </Marker>
    );
  }
  if (message.role === "user") {
    return (
      <Message align="end" data-testid="session-message-user">
        <MessageContent className="max-w-[85%]">
          <Bubble align="end">
            <BubbleContent className="whitespace-pre-wrap break-words">
              {message.content}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }
  return (
    <Message data-testid="session-message-agent">
      <MessageContent>
        <MessageHeader className="gap-1.5 px-0">
          <BotIcon data-icon="inline-start" />
          {t.workbench.agent}
        </MessageHeader>
        <AssistantContent message={message} onOpenRun={onOpenRun} />
        {message.errorText ? (
          <Alert variant="destructive" className="mt-2 max-w-3xl">
            <CircleAlert />
            <AlertDescription>{message.errorText}</AlertDescription>
          </Alert>
        ) : null}
        <MessageFooter className="px-0">
          {new Date(message.createdAt).toLocaleTimeString()}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

export function SessionTranscript({
  messages,
  runs = [],
  onOpenRun,
}: {
  messages: AgentMessage[];
  runs?: SessionRunLink[];
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
  const hasStreamingMessage = messages.some((message) => message.status === "streaming");
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-transcript">
      {runs.length > 0 && onOpenRun ? <SessionRunLinks runs={runs} onOpenRun={onOpenRun} /> : null}
      <MessageScrollerProvider autoScroll={hasStreamingMessage}>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-4xl px-4 py-5 md:px-6">
              {messages.length === 0 ? (
                <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
                  {t.workbench.startConversation}
                </div>
              ) : (
                messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                  >
                    <TranscriptRow message={message} onOpenRun={onOpenRun} />
                  </MessageScrollerItem>
                ))
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
