/** Transcript projected exclusively from Pi messages and tool lifecycle events. */

import { BotIcon, ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { memo } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { ToolExecutionCard } from "../components/ToolExecutionCard";
import type { AgentMessage, AgentToolCall } from "../hooks/useSessionAgent";
import { AgentMarkdown } from "./AgentMarkdown";

export type TranscriptProps = {
  messages: AgentMessage[];
  className?: string;
};

function ThinkingBlock({ thinking, streaming }: { thinking: string; streaming?: boolean }) {
  const { t } = useI18n();
  return (
    <Collapsible defaultOpen={streaming} className="w-full min-w-0">
      <CollapsibleTrigger className="group flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <span className="min-w-0 truncate">
          {streaming ? t.agentWorkspace.thinkingStreaming : t.agentWorkspace.thinking}
        </span>
        {streaming ? <Spinner className="size-3" /> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-[7px] min-w-0 border-l-2 border-border/60 pl-3">
        <pre className="m-0 max-h-64 min-w-0 overflow-y-auto font-sans text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {thinking}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Memoized: every streaming tick produces a new messages array, but finalized
// rows keep their object identity — memo stops full-transcript re-renders.
// Exported so Node Attempt dialog reuses the same MD + tool chrome as Session.
export const TranscriptMessage = memo(function TranscriptMessage({
  message,
}: {
  message: AgentMessage;
}) {
  const { t } = useI18n();
  const isUser = message.role === "user";
  const isError = message.status === "error" || Boolean(message.errorText);
  const isStreaming = message.status === "streaming";
  const toolsById = new Map((message.tools ?? []).map((tool) => [tool.id, tool]));
  const useParts = !isUser && Boolean(message.parts?.length);

  const renderTool = (tool: AgentToolCall) => (
    <ToolExecutionCard
      key={tool.id}
      tool={tool}
      settled={!isStreaming && message.status !== "streaming"}
    />
  );

  if (message.role === "system" && message.status === "aborted") {
    return (
      <Marker
        data-testid="agent-message"
        data-role="system"
        data-status="aborted"
        variant="separator"
        role="status"
      >
        <MarkerContent>{message.content}</MarkerContent>
      </Marker>
    );
  }

  if (message.role === "system" || message.role === "tool") {
    return (
      <div
        data-testid="agent-message"
        data-role={message.role}
        className="flex w-full justify-center"
      >
        <p className="w-full text-center text-xs text-muted-foreground">{message.content}</p>
      </div>
    );
  }

  const waiting =
    isStreaming && !message.content.trim() && !message.thinking?.trim() && !message.tools?.length;

  // User turns keep a right-aligned bubble; the bubble alone encodes the role.
  if (isUser) {
    return (
      <div
        data-testid="agent-message"
        data-role="user"
        data-status={message.status}
        className="flex w-full min-w-0 justify-end"
      >
        <Bubble variant="default" align="end" className="max-w-[85%]">
          <BubbleContent>
            <div className="break-words whitespace-pre-wrap">{message.content}</div>
          </BubbleContent>
        </Bubble>
      </div>
    );
  }

  // Assistant turns render directly on the canvas — no bubble, no role header.
  return (
    <div
      data-testid="agent-message"
      data-role={message.role}
      data-status={message.status}
      className="flex w-full min-w-0 flex-col gap-2"
    >
      {isError ? (
        <span
          role="status"
          aria-live="assertive"
          className="inline-flex items-center gap-1 text-xs text-destructive"
        >
          <CircleAlertIcon className="size-3.5" />
          {t.agentWorkspace.statusError}
        </span>
      ) : null}

      {!useParts && message.thinking ? (
        <ThinkingBlock
          thinking={message.thinking}
          streaming={message.thinkingStatus === "streaming"}
        />
      ) : null}

      {useParts ? (
        <div className="flex w-full min-w-0 flex-col gap-2" data-testid="message-parts">
          {message.parts!.map((part, index) => {
            if (part.type === "thinking") {
              return (
                <ThinkingBlock
                  key={`thinking-${index}`}
                  thinking={part.thinking}
                  streaming={
                    isStreaming &&
                    message.thinkingStatus === "streaming" &&
                    index === message.parts!.length - 1
                  }
                />
              );
            }
            if (part.type === "text") {
              return part.text.trim() ? (
                <AgentMarkdown
                  key={`text-${index}`}
                  content={part.text}
                  streaming={isStreaming && index === message.parts!.length - 1}
                />
              ) : null;
            }
            const tool = toolsById.get(part.toolId);
            return tool ? renderTool(tool) : null;
          })}
        </div>
      ) : message.content ? (
        <AgentMarkdown content={message.content} streaming={isStreaming} />
      ) : waiting ? (
        <div
          className="flex items-center gap-2 text-muted-foreground"
          data-testid="waiting-for-events"
        >
          <Spinner className="size-3.5" />
          <span className="text-xs">{t.agentWorkspace.waitingForEvents}</span>
        </div>
      ) : null}

      {isError && (message.errorText || !message.content) ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs break-words whitespace-pre-wrap text-destructive"
          data-testid="agent-message-error"
        >
          {message.errorText ?? t.agentWorkspace.statusError}
        </div>
      ) : null}

      {!useParts && message.tools?.length ? (
        <div className="flex w-full min-w-0 flex-col gap-1">{message.tools.map(renderTool)}</div>
      ) : null}
    </div>
  );
});

/**
 * Compact message list for embedded surfaces (Node Attempt dialog).
 * Same TranscriptMessage chrome as Session — no scroller / empty hero.
 */
export function TranscriptMessageList({
  messages,
  className,
  streaming = false,
}: {
  messages: AgentMessage[];
  className?: string;
  /** When true, mark the last assistant row as still streaming. */
  streaming?: boolean;
}) {
  if (messages.length === 0) return null;
  const lastId = messages[messages.length - 1]?.id;
  return (
    <div
      className={cn("flex w-full min-w-0 flex-col gap-3", className)}
      data-testid="transcript-message-list"
    >
      {messages.map((message) => {
        const live =
          streaming &&
          message.id === lastId &&
          message.role === "assistant" &&
          message.status !== "done" &&
          message.status !== "error" &&
          message.status !== "aborted";
        const view: AgentMessage =
          live && message.status !== "streaming"
            ? { ...message, status: "streaming" }
            : message;
        return <TranscriptMessage key={message.id} message={view} />;
      })}
    </div>
  );
}

export function Transcript({ messages, className }: TranscriptProps) {
  const { t } = useI18n();

  if (messages.length === 0) {
    return (
      <div
        data-testid="agent-transcript-empty"
        className={cn("flex min-h-0 flex-1 items-center justify-center px-4", className)}
      >
        <Empty className="border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>{t.agentWorkspace.emptyTitle}</EmptyTitle>
            <EmptyDescription>{t.agentWorkspace.emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <MessageScrollerProvider autoScroll>
        <MessageScroller data-testid="agent-transcript" className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-3 py-4 md:px-4">
              {messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  <TranscriptMessage message={message} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton aria-label={t.agentWorkspace.jumpToLatest} />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
