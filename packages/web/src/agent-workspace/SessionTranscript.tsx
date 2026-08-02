import type { AgentMessage } from "@okf-wiki/contract";
import { MessageSquareIcon, WorkflowIcon } from "lucide-react";
import {
  AssistantTurn,
  describeRunStatus,
  StatusBadge,
} from "@/components/agent-ui";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { useI18n, type MessageTree } from "../i18n";
import type { SessionRunLink } from "./session-run-links";

function runStateLabel(run: SessionRunLink, labels: Record<string, string>): string {
  return labels[run.state] ?? run.state.replaceAll("_", " ");
}

function assistantLabels(t: MessageTree) {
  return {
    thinking: t.workbench.thinking,
    thought: t.workbench.thought,
    thinkingElapsed: t.workbench.thinkingElapsed,
    generating: t.workbench.generating,
    toolInput: t.workbench.rawInput,
    toolOutput: t.workbench.rawOutput,
    toolError: t.workbench.toolError,
    openRun: t.workbench.openRun,
    toolCallsSummary: t.workbench.toolCallsSummary,
    copy: t.workbench.copy,
    copied: t.workbench.copied,
    toolNames: {
      wikiProduce: t.workbench.toolNames.wiki_produce,
      status: {
        pending: t.workbench.toolPending,
        running: t.workbench.toolRunning,
        done: t.workbench.toolCompleted,
        error: t.workbench.toolFailed,
      },
    },
  };
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
          <Bubble align="end" variant="secondary">
            <BubbleContent className="whitespace-pre-wrap break-words">
              {message.content}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }
  return (
    <Message data-testid="session-message-agent" className="group/assistant-row">
      <MessageContent>
        <AssistantTurn
          message={message}
          labels={assistantLabels(t)}
          onOpenRun={onOpenRun}
        />
        <MessageFooter className="px-0 opacity-0 transition-opacity group-hover/assistant-row:opacity-100 group-focus-within/assistant-row:opacity-100">
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
                <Empty className="min-h-48 border-0 py-12" data-testid="session-transcript-empty">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageSquareIcon />
                    </EmptyMedia>
                    <EmptyTitle>{t.workbench.conversation}</EmptyTitle>
                    <EmptyDescription>{t.workbench.startConversation}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
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
