import type {
  AttemptTraceEvent,
  WikiRunAttempt,
  WikiRunNode,
  WikiRunSnapshot,
  WikiRunSpec,
} from "@okf-wiki/contract";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronRightIcon,
  Clock3Icon,
  LoaderCircleIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MessageTree } from "../i18n";
import { MarkdownDocument } from "../shared/MarkdownDocument";
import type { FollowMode } from "./observation-state";

function statusVariant(state: string): "default" | "secondary" | "outline" | "destructive" {
  if (state === "failed" || state === "cancelled") return "destructive";
  if (state === "running" || state === "suspended") return "default";
  return "outline";
}

function elapsed(attempt: WikiRunAttempt): string | null {
  const end = attempt.endedAt ? new Date(attempt.endedAt).getTime() : Date.now();
  const start = new Date(attempt.startedAt).getTime();
  if (!Number.isFinite(start) || end < start) return null;
  const seconds = Math.round((end - start) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function attemptStateLabel(state: string, t: MessageTree): string {
  return (
    t.workbench.nodeStates[state as keyof typeof t.workbench.nodeStates] ??
    state.replaceAll("_", " ")
  );
}

function ToolTransaction({
  call,
  result,
  t,
}: {
  call?: Extract<AttemptTraceEvent, { kind: "tool_call" }>;
  result?: Extract<AttemptTraceEvent, { kind: "tool_result" }>;
  t: MessageTree;
}) {
  const failed = result?.status === "error";
  const title = call?.name ?? result?.name ?? t.workbench.traceKinds.tool_result;
  const status = result
    ? failed
      ? t.workbench.toolFailed
      : t.workbench.toolCompleted
    : t.workbench.toolCalled;
  const request = call?.args;
  const response = result?.output;
  return (
    <details className="border-y border-border py-3" open={failed}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <Badge variant={failed ? "destructive" : "outline"}>{status}</Badge>
        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {request ? (
          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t.workbench.toolInput}
            </p>
            <pre className="okf-code-snippet max-h-80 overflow-auto">{request}</pre>
          </section>
        ) : null}
        {response ? (
          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t.workbench.toolOutput}
            </p>
            <pre className="okf-code-snippet max-h-80 overflow-auto">{response}</pre>
          </section>
        ) : null}
      </div>
    </details>
  );
}

function RawEvent({ event }: { event: AttemptTraceEvent }) {
  return (
    <pre className="okf-code-snippet max-h-[34rem] overflow-auto">
      {JSON.stringify(event, null, 2)}
    </pre>
  );
}

type ToolCallEvent = Extract<AttemptTraceEvent, { kind: "tool_call" }>;
type ToolResultEvent = Extract<AttemptTraceEvent, { kind: "tool_result" }>;
type ActivityEntry =
  | { kind: "tool"; call?: ToolCallEvent; result?: ToolResultEvent }
  | { kind: "event"; event: Exclude<AttemptTraceEvent, ToolCallEvent | ToolResultEvent> };

function ActivityFeed({
  trace,
  t,
  followMode,
}: {
  trace: AttemptTraceEvent[];
  t: MessageTree;
  followMode: FollowMode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rendered = useMemo<ActivityEntry[]>(() => {
    const pairedResults = new Set<number>();
    const entries: ActivityEntry[] = [];
    for (const event of trace) {
      if (event.kind === "tool_call") {
        const result = trace.find(
          (candidate) =>
            candidate.kind === "tool_result" &&
            candidate.ordinal > event.ordinal &&
            candidate.toolCallId &&
            candidate.toolCallId === event.toolCallId,
        ) as Extract<AttemptTraceEvent, { kind: "tool_result" }> | undefined;
        if (result) pairedResults.add(result.ordinal);
        entries.push({ kind: "tool", call: event, result });
        continue;
      }
      if (event.kind === "tool_result") {
        if (!pairedResults.has(event.ordinal)) entries.push({ kind: "tool", result: event });
        continue;
      }
      entries.push({ kind: "event", event });
    }
    return entries;
  }, [trace]);

  useEffect(() => {
    if (followMode !== "selected-live") return;
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [followMode, rendered.length]);

  if (trace.length === 0)
    return <p className="py-12 text-center text-sm text-muted-foreground">{t.workbench.noTrace}</p>;
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5 md:px-6">
        {rendered.map((item) => {
          if (item.kind === "tool")
            return (
              <ToolTransaction
                key={item.call?.ordinal ?? item.result?.ordinal}
                call={item.call}
                result={item.result}
                t={t}
              />
            );
          const event = item.event;
          if (event.kind === "input") {
            return (
              <details key={event.ordinal} className="border-y border-border py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
                  <span>{t.workbench.attemptInput}</span>
                  <time className="shrink-0 font-mono text-xs font-normal text-muted-foreground">
                    {new Date(event.at).toLocaleTimeString()}
                  </time>
                </summary>
                <pre className="okf-code-snippet mt-3 max-h-[36rem] overflow-auto">
                  {event.content}
                </pre>
              </details>
            );
          }
          if (event.kind === "assistant") {
            return (
              <article key={event.ordinal} className="border-l-2 border-primary/35 pl-4">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <BotIcon className="size-3.5" />
                    {t.workbench.agent}
                  </span>
                  <time className="font-mono font-normal">
                    {new Date(event.at).toLocaleTimeString()}
                  </time>
                </div>
                <MarkdownDocument content={event.content} />
              </article>
            );
          }
          if (event.kind === "terminal") {
            const status =
              event.status === "error"
                ? t.workbench.toolFailed
                : event.status === "cancelled"
                  ? t.workbench.nodeStates.cancelled
                  : t.workbench.toolCompleted;
            return (
              <Alert
                key={event.ordinal}
                variant={event.status === "error" ? "destructive" : "default"}
              >
                <TerminalIcon />
                <AlertTitle>{status}</AlertTitle>
                <AlertDescription>{event.summary}</AlertDescription>
              </Alert>
            );
          }
          return (
            <Alert key={event.ordinal}>
              <TerminalIcon />
              <AlertTitle>{t.workbench.traceKinds.truncated}</AlertTitle>
              <AlertDescription>
                {event.reason}: {event.limitBytes}
              </AlertDescription>
            </Alert>
          );
        })}
      </div>
    </div>
  );
}

export function RunPlanDetails({ spec, t }: { spec: WikiRunSpec | null; t: MessageTree }) {
  if (!spec)
    return (
      <p className="px-4 py-12 text-center text-sm text-muted-foreground">
        {t.workbench.planPending}
      </p>
    );
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-5 md:px-6">
      <section>
        <h3 className="text-sm font-medium">{t.specReview.audience}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{spec.audience}</p>
        <p className="mt-3 max-w-4xl text-sm">{spec.summary}</p>
      </section>
      <section>
        <h3 className="text-sm font-medium">{t.specReview.domains}</h3>
        <div className="mt-3 divide-y divide-border border-y border-border">
          {spec.domains.map((domain) => (
            <div key={domain.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{domain.title}</p>
                <Badge variant="outline">
                  {domain.critical ? t.specReview.blocking : t.specReview.optional}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{domain.scope}</p>
              {domain.questions.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {domain.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3 className="text-sm font-medium">{t.specReview.pages}</h3>
        <div className="mt-3 divide-y divide-border border-y border-border">
          {spec.pages.map((page) => (
            <div key={page.path} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-xs">{page.path}</p>
                {page.template ? <Badge variant="outline">{page.template}</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{page.purpose}</p>
              {page.questions.length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">{page.questions.join(" · ")}</p>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      {spec.openQuestions.length > 0 ? (
        <section>
          <h3 className="text-sm font-medium">{t.specReview.openQuestions}</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            {spec.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="text-sm font-medium">{t.specReview.acceptance}</h3>
        <dl className="mt-3 grid gap-x-6 gap-y-3 border-y border-border py-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.reviewEnabled}</dt>
            <dd className="mt-1">{spec.acceptance.reviewRequired ? t.common.on : t.common.off}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.autoRepair}</dt>
            <dd className="mt-1">{spec.acceptance.autoRepair ? t.common.on : t.common.off}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.semanticRepairRounds}</dt>
            <dd className="mt-1">{spec.acceptance.maxRepairRounds}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.mechanicalRepairRounds}</dt>
            <dd className="mt-1">{spec.acceptance.maxHardValidateRepairRounds}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export function AttemptObservation({
  snapshot,
  selectedNode,
  selectedAttempt,
  trace,
  spec,
  onBack,
  onSelectAttempt,
  onLoadEarlier,
  canLoadEarlier,
  loadingEarlier,
  followMode,
  onFollowModeChange,
  t,
}: {
  snapshot: WikiRunSnapshot;
  selectedNode: WikiRunNode | null;
  selectedAttempt: WikiRunAttempt | null;
  trace: AttemptTraceEvent[];
  spec: WikiRunSpec | null;
  onBack: () => void;
  onSelectAttempt: (attempt: WikiRunAttempt) => void;
  onLoadEarlier: () => void;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  followMode: FollowMode;
  onFollowModeChange: (mode: FollowMode) => void;
  t: MessageTree;
}) {
  const attempts = selectedNode
    ? snapshot.attempts
        .filter((attempt) => attempt.nodeKey === selectedNode.key)
        .slice()
        .sort(
          (left, right) =>
            right.nodeGeneration - left.nodeGeneration || right.runIndex - left.runIndex,
        )
    : [];
  const live = selectedAttempt?.state === "running" || selectedAttempt?.state === "suspended";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="attempt-observation">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            {t.workbench.backToGraph}
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {selectedNode?.label ?? t.workbench.attempts}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {selectedAttempt?.attemptId ?? selectedNode?.key ?? ""}
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={followMode === "selected-live"}
            disabled={!live}
            onCheckedChange={(checked) => onFollowModeChange(checked ? "selected-live" : "pinned")}
          />
          {t.workbench.followLive}
        </label>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-border bg-muted/15 md:w-64 md:border-r md:border-b-0">
          <div className="flex items-center gap-2 px-4 py-3 text-xs font-medium text-muted-foreground">
            <Clock3Icon className="size-3.5" />
            {t.workbench.attemptHistory}
          </div>
          <div className="flex max-h-40 gap-2 overflow-x-auto px-2 pb-2 md:max-h-none md:flex-col md:overflow-y-auto md:px-2">
            {attempts.map((attempt) => (
              <Button
                key={attempt.attemptId}
                size="sm"
                variant={attempt.attemptId === selectedAttempt?.attemptId ? "secondary" : "ghost"}
                className="h-auto min-w-48 shrink-0 justify-start px-3 py-2 text-left md:min-w-0"
                onClick={() => onSelectAttempt(attempt)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">
                    #{attempt.nodeGeneration} · {attempt.runIndex}
                  </span>
                  <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                    {elapsed(attempt)}
                    {attempt.failureClass ? ` · ${attempt.failureClass}` : ""}
                  </span>
                </span>
                <Badge variant={statusVariant(attempt.state)}>
                  {attemptStateLabel(attempt.state, t)}
                </Badge>
              </Button>
            ))}
            {attempts.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t.workbench.noAttemptStarted}
              </p>
            ) : null}
          </div>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Tabs defaultValue="activity" className="flex min-h-0 flex-1 flex-col">
            <TabsList variant="line" className="shrink-0 border-b border-border px-4 md:px-6">
              <TabsTrigger value="activity">{t.workbench.nodeActivity}</TabsTrigger>
              <TabsTrigger value="plan">{t.workbench.plan}</TabsTrigger>
              <TabsTrigger value="events">{t.workbench.rawEvents}</TabsTrigger>
            </TabsList>
            <TabsContent value="activity" className="min-h-0 flex-1 overflow-hidden">
              {selectedAttempt ? (
                <ActivityFeed trace={trace} t={t} followMode={followMode} />
              ) : (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {t.workbench.noAttemptStarted}
                </p>
              )}
            </TabsContent>
            <TabsContent value="plan" className="min-h-0 flex-1 overflow-y-auto">
              <RunPlanDetails spec={spec} t={t} />
            </TabsContent>
            <TabsContent value="events" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-5 md:px-6">
                {canLoadEarlier ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    disabled={loadingEarlier}
                    onClick={onLoadEarlier}
                  >
                    {loadingEarlier ? <LoaderCircleIcon className="animate-spin" /> : null}
                    {t.workbench.loadEarlier}
                  </Button>
                ) : null}
                {trace.map((event) => (
                  <RawEvent key={event.ordinal} event={event} />
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}
