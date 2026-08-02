import {
  BotIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PiSessionSummary, WikiRunListItem } from "../api";
import type { MessageTree } from "../i18n";
import { localizedLabel, runBadge, runLabel } from "./workbench-utils";

type TimelineSidebarProps = {
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  runs: WikiRunListItem[];
  activeRunId: string | null;
  onSelectSession: (id: string) => void;
  onSelectRun: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  onCollapse?: () => void;
  creating: boolean;
  t: MessageTree;
};

export function TimelineSidebar({
  sessions,
  activeSessionId,
  runs,
  activeRunId,
  onSelectSession,
  onSelectRun,
  onCreateSession,
  onDeleteSession,
  onCollapse,
  creating,
  t,
}: TimelineSidebarProps) {
  return (
    <nav
      className="flex min-h-0 flex-col border-r border-border bg-muted/20"
      aria-label={t.workbench.activity}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{t.workbench.sessions}</span>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onCreateSession}
            disabled={creating}
            aria-label={t.workbench.newSession}
            title={t.workbench.newSession}
          >
            <PlusIcon />
          </Button>
          {onCollapse ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onCollapse}
              aria-label={t.app.collapseSidebar}
              title={t.app.collapseSidebar}
              aria-expanded
            >
              <PanelLeftCloseIcon />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-1 p-2">
          {sessions.map((session) => (
            <div key={session.id} className="group flex min-w-0 items-center gap-1">
              <Button
                variant={session.id === activeSessionId ? "secondary" : "ghost"}
                size="sm"
                className="min-w-0 flex-1 justify-start"
                onClick={() => onSelectSession(session.id)}
              >
                <BotIcon data-icon="inline-start" />
                <span className="truncate">{session.title || t.workbench.untitledSession}</span>
              </Button>
              {sessions.length > 1 ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                  onClick={() => onDeleteSession(session.id)}
                  aria-label={t.workbench.deleteSession}
                  title={t.workbench.deleteSession}
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="border-y border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          {t.workbench.runs}
        </div>
        <div className="flex flex-col gap-1 p-2">
          {runs.map((run) => (
            <Button
              key={run.runId}
              variant={run.runId === activeRunId ? "secondary" : "ghost"}
              size="sm"
              className="h-auto min-h-9 justify-start py-1.5 text-left"
              onClick={() => onSelectRun(run.runId)}
            >
              <WorkflowIcon data-icon="inline-start" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {run.runId.slice(0, 12)}
              </span>
              <Badge variant={runBadge(run)}>
                {run.attention === "none"
                  ? runLabel(run, t)
                  : localizedLabel(t.workbench.runStates, run.attention)}
              </Badge>
            </Button>
          ))}
          {runs.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">{t.workbench.noRuns}</p>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

export function CollapsedTimelineSidebar({
  onExpand,
  onShowConversation,
  onShowRun,
  t,
}: {
  onExpand: () => void;
  onShowConversation: () => void;
  onShowRun: () => void;
  t: MessageTree;
}) {
  return (
    <nav className="flex h-full flex-col items-center gap-2 py-2" aria-label={t.workbench.activity}>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onExpand}
        aria-label={t.app.expandSidebar}
        title={t.app.expandSidebar}
        aria-expanded={false}
      >
        <PanelLeftOpenIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onShowConversation}
        aria-label={t.workbench.sessions}
        title={t.workbench.sessions}
      >
        <BotIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onShowRun}
        aria-label={t.workbench.runs}
        title={t.workbench.runs}
      >
        <WorkflowIcon />
      </Button>
    </nav>
  );
}
