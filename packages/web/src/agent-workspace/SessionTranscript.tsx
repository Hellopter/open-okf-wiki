import type { AgentMessage, AgentToolCall } from "@okf-wiki/contract";
import { BotIcon, ChevronRightIcon, CircleAlert, WorkflowIcon, WrenchIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { useI18n } from "../i18n";
import { MarkdownDocument } from "../shared/MarkdownDocument";
import { runIdFromToolReceipt, type SessionRunLink } from "./session-run-links";

function toolLabel(tool: AgentToolCall, completed: string, failed: string): string {
  const status =
    tool.status === "done" ? completed : tool.status === "error" ? failed : tool.status;
  return `${tool.name.replaceAll("_", " ")} · ${status}`;
}

function runStateLabel(run: SessionRunLink, labels: Record<string, string>): string {
  return labels[run.state] ?? run.state.replaceAll("_", " ");
}

function runBadgeVariant(run: SessionRunLink): "default" | "secondary" | "outline" | "destructive" {
  if (run.state === "failed" || run.state === "cancelled") return "destructive";
  if (run.attention === "gate" || run.attention === "review" || run.attention === "paused")
    return "outline";
  return run.state === "published" ? "default" : "secondary";
}

function ToolTrace({
  tool,
  onOpenRun,
}: {
  tool: AgentToolCall;
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
  const runId = runIdFromToolReceipt(tool);
  const text =
    tool.details?.summary ??
    tool.output ??
    (tool.args ? JSON.stringify(tool.args, null, 2) : undefined);
  return (
    <div className="flex max-w-3xl items-start gap-2" data-testid={`agent-tool-${tool.name}`}>
      <details className="min-w-0 flex-1 border-y border-border py-2">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground">
          <WrenchIcon data-icon="inline-start" />
          <span className="min-w-0 flex-1 truncate">
            {toolLabel(tool, t.workbench.toolCompleted, t.workbench.toolFailed)}
          </span>
          <ChevronRightIcon className="transition-transform group-open:rotate-90" />
        </summary>
        {text ? <pre className="okf-code-snippet mt-2">{text}</pre> : null}
      </details>
      {runId && onOpenRun ? (
        <Button
          size="xs"
          variant="ghost"
          className="mt-1 shrink-0"
          onClick={() => onOpenRun(runId)}
        >
          <WorkflowIcon data-icon="inline-start" />
          {t.workbench.openRun}
        </Button>
      ) : null}
    </div>
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
        {runs.map((run) => (
          <Button key={run.runId} size="sm" variant="outline" onClick={() => onOpenRun(run.runId)}>
            <WorkflowIcon data-icon="inline-start" />
            <span className="font-mono">{run.runId.slice(0, 12)}</span>
            <Badge variant={runBadgeVariant(run)}>
              {runStateLabel(run, t.workbench.runStates)}
            </Badge>
          </Button>
        ))}
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
        {message.content ? (
          <MarkdownDocument
            content={message.content}
            mode={message.status === "streaming" ? "streaming" : "static"}
          />
        ) : null}
        {message.tools?.map((tool) => (
          <ToolTrace key={tool.id} tool={tool} onOpenRun={onOpenRun} />
        ))}
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
