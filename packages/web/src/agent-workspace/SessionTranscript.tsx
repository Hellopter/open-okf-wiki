import type { SessionMessage } from "@okf-wiki/contract";
import { MessageSquareIcon, WorkflowIcon } from "lucide-react";
import { describeRunStatus, StatusBadge, ToolExecutionGroup } from "@/components/agent-ui";
import type { ToolItemVM } from "@/components/agent-ui/adapters/types";
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
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { type MessageTree, useI18n } from "../i18n";
import { MarkdownDocument } from "../shared/MarkdownDocument";
import type { SessionRunLink } from "./session-run-links";

function runStateLabel(run: SessionRunLink, labels: Record<string, string>): string {
  return labels[run.state] ?? run.state.replaceAll("_", " ");
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
            <Button
              key={run.runId}
              size="sm"
              variant="outline"
              onClick={() => onOpenRun(run.runId)}
            >
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

function sessionToolItems(message: SessionMessage, t: MessageTree): ToolItemVM[] {
  const labels = {
    pending: t.workbench.toolPending,
    running: t.workbench.toolRunning,
    done: t.workbench.toolCompleted,
    error: t.workbench.toolFailed,
  };
  return (message.tools ?? []).map((tool) => ({
    id: tool.id,
    title: tool.name === "wiki_produce" ? t.workbench.toolNames.wiki_produce : tool.name,
    status: tool.status,
    statusLabel: labels[tool.status],
    ...(tool.receipt?.summary ? { summary: tool.receipt.summary } : {}),
    ...(tool.receipt?.runId ? { openRunId: tool.receipt.runId } : {}),
    kind: tool.name === "wiki_produce" ? "wiki_produce" : "generic",
    defaultOpen: tool.status === "pending" || tool.status === "running" || tool.status === "error",
  }));
}

function TranscriptRow({
  message,
  onOpenRun,
}: {
  message: SessionMessage;
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
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
  const tools = sessionToolItems(message, t);
  return (
    <Message data-testid="session-message-agent">
      <MessageContent>
        <div className="flex min-w-0 flex-col gap-2">
          <ToolExecutionGroup
            items={tools}
            openRunLabel={t.workbench.openRun}
            inputLabel={t.workbench.toolInput}
            outputLabel={t.workbench.toolOutput}
            errorLabel={t.workbench.toolError}
            toolCallsSummaryLabel={t.workbench.toolCallsSummary}
            onOpenRun={onOpenRun}
          />
          {message.content ? (
            <MarkdownDocument
              content={message.content}
              mode={message.status === "streaming" ? "streaming" : "static"}
            />
          ) : null}
          {message.errorText ? (
            <p className="text-sm text-destructive">{message.errorText}</p>
          ) : null}
        </div>
      </MessageContent>
    </Message>
  );
}

export function SessionTranscript({
  messages,
  runs = [],
  onOpenRun,
}: {
  messages: SessionMessage[];
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
            <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-3 px-4 py-5 md:px-6">
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
