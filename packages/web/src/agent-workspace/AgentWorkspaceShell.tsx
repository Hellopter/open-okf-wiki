/**
 * Agent Workspace shell (ADR 0032 hard-cut).
 *
 * left: collapsible session list · center: transcript + Active Run + composer
 *
 * Right ContextPanels rail removed. Active run observation lives inline
 * (ActiveRunBar / ActiveRunDetails); URL `?run=` selects the run, local
 * `graphOpen` expands plan/graph under the bar (not a Sheet/Dialog).
 */

import { LayoutListIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { SessionUsage } from "@okf-wiki/contract";
import type { PiSessionSummary, WikiRunListItem, WorkspaceConfig } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { useI18n } from "../i18n";
import { ActiveRunBar } from "./components/ActiveRunBar";
import { ActiveRunDetails } from "./components/ActiveRunDetails";
import { Composer } from "./composer/Composer";
import type { AgentMessage, AgentStatus, ConnectionStatus } from "./hooks/useSessionAgent";
import { SessionList } from "./session-list/SessionList";
import { Transcript } from "./transcript/Transcript";

const CONNECTION_TOAST_ID = "agent-connection-status";

/** localStorage: "1" = collapsed, "0" / missing = expanded. */
const LEFT_STORAGE_KEY = "okf-wiki.agent.left-collapsed";

function readCollapsed(key: string, defaultCollapsed = false): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultCollapsed;
    return v === "1";
  } catch {
    return defaultCollapsed;
  }
}

function writeCollapsed(key: string, collapsed: boolean) {
  try {
    localStorage.setItem(key, collapsed ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
}

export type AgentWorkspaceShellProps = {
  workspaceId: string;
  workspace: WorkspaceConfig | null;
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  creatingSession?: boolean;
  deletingSessionId?: string | null;
  messages: AgentMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onAbort: () => void;
  /** Session-scoped chat model switch (composer dropdown). */
  onSetModel?: (profileId: string) => Promise<boolean>;
  agentStatus: AgentStatus;
  agentReady: boolean;
  /** SSE lifecycle — only degraded states paint chrome; live is silent. */
  connectionStatus?: ConnectionStatus;
  agentError?: unknown;
  onDismissAgentError?: () => void;
  recentRuns?: WikiRunListItem[];
  /** Dual-surface WikiRun chrome (Session vs Run stop). */
  showStopRun?: boolean;
  onStopRun?: () => void;
  runBusy?: boolean;
  runNeedsOperator?: boolean;
  runStateLabel?: string;
  /** Ephemeral context-fill chip (Composer); hidden when null. */
  sessionUsage?: SessionUsage | null;
  className?: string;
};

export function AgentWorkspaceShell({
  workspaceId,
  workspace,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  creatingSession = false,
  deletingSessionId = null,
  messages,
  input,
  onInputChange,
  onSend,
  onAbort,
  onSetModel,
  agentStatus,
  agentReady,
  connectionStatus = "offline",
  agentError,
  onDismissAgentError,
  recentRuns = [],
  showStopRun = false,
  onStopRun,
  runBusy = false,
  runNeedsOperator = false,
  runStateLabel,
  sessionUsage = null,
  className,
}: AgentWorkspaceShellProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get("run");
  const [leftSheetOpen, setLeftSheetOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(() => readCollapsed(LEFT_STORAGE_KEY, false));
  /** Local graph expand — not tied to URL `?run=`. */
  const [graphOpen, setGraphOpen] = useState(false);

  // Connection UX: sonner toast for transitions (not a permanent chrome strip / dialog).
  // live = silent; reconnecting/offline = toast; connecting only after leaving live.
  const prevConnectionRef = useRef<ConnectionStatus | null>(null);
  useEffect(() => {
    const prev = prevConnectionRef.current;
    prevConnectionRef.current = connectionStatus;
    if (prev === null) {
      // Initial mount: don't toast "connecting" / "offline" before first snapshot.
      return;
    }
    if (connectionStatus === "live") {
      toast.dismiss(CONNECTION_TOAST_ID);
      if (prev === "reconnecting" || prev === "offline") {
        toast.success(t.agentWorkspace.connectionLive, { id: CONNECTION_TOAST_ID, duration: 2000 });
      }
      return;
    }
    if (connectionStatus === "reconnecting") {
      toast.message(t.agentWorkspace.connectionReconnecting, {
        id: CONNECTION_TOAST_ID,
        duration: Infinity,
      });
      return;
    }
    if (connectionStatus === "offline") {
      toast.error(t.agentWorkspace.connectionOffline, {
        id: CONNECTION_TOAST_ID,
        duration: Infinity,
      });
      return;
    }
    if (connectionStatus === "connecting" && (prev === "live" || prev === "reconnecting")) {
      toast.message(t.agentWorkspace.connectionConnecting, {
        id: CONNECTION_TOAST_ID,
        duration: Infinity,
      });
    }
  }, [connectionStatus, t.agentWorkspace]);

  // Sticky (Infinity) connection toasts must not outlive this surface —
  // dismiss on unmount so navigating away never leaves a stale banner.
  useEffect(
    () => () => {
      toast.dismiss(CONNECTION_TOAST_ID);
    },
    [],
  );

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(LEFT_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const sessionList = (
    <SessionList
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelect={(id) => {
        onSelectSession(id);
        setLeftSheetOpen(false);
      }}
      onCreate={onCreateSession}
      onDelete={onDeleteSession}
      creating={creatingSession}
      deletingId={deletingSessionId}
      onCollapse={!isMobile ? toggleLeft : undefined}
    />
  );

  const rootPath = workspace?.rootPath;

  return (
    <div
      data-testid="agent-workspace-shell"
      data-connection-status={connectionStatus}
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-background", className)}
    >
      {isMobile ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t.agentWorkspace.sessions}
            title={t.agentWorkspace.sessions}
            onClick={() => setLeftSheetOpen(true)}
            data-testid="agent-mobile-sessions"
          >
            <LayoutListIcon />
            <span className="sr-only">{t.agentWorkspace.sessions}</span>
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {workspace?.name ?? t.agentWorkspace.title}
          </div>
        </header>
      ) : null}

      {/* Connection status is toast-only; keep a stable test hook on the shell. */}
      <span
        className="sr-only"
        data-testid="agent-connection-status"
        data-connection-status={connectionStatus}
      >
        {connectionStatus === "live"
          ? t.agentWorkspace.connectionLive
          : connectionStatus === "connecting"
            ? t.agentWorkspace.connectionConnecting
            : connectionStatus === "reconnecting"
              ? t.agentWorkspace.connectionReconnecting
              : t.agentWorkspace.connectionOffline}
      </span>

      {agentError ? (
        <div className="shrink-0 px-2.5 pt-2">
          <ErrorBanner error={agentError} onDismiss={onDismissAgentError} />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!isMobile ? (
          leftCollapsed ? (
            <aside
              data-testid="agent-left-rail"
              data-collapsed="true"
              className="flex w-10 shrink-0 flex-col items-center border-r border-border bg-muted/20 py-2"
            >
              {/* One control: decorative list icon was previously not clickable. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t.agentWorkspace.expandSessions}
                      aria-expanded={false}
                      data-testid="agent-left-expand"
                      onClick={toggleLeft}
                    />
                  }
                >
                  <LayoutListIcon />
                </TooltipTrigger>
                <TooltipContent side="right">{t.agentWorkspace.expandSessions}</TooltipContent>
              </Tooltip>
            </aside>
          ) : (
            <aside
              data-testid="agent-left-pane"
              data-collapsed="false"
              className="flex w-52 shrink-0 flex-col border-r border-border md:w-56"
            >
              {sessionList}
            </aside>
          )
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Transcript messages={messages} />
          {/* Bar above composer; graph expands under the bar (not a right Sheet). */}
          <ActiveRunBar
            workspaceId={workspaceId}
            rootPath={rootPath}
            recentRuns={recentRuns}
            graphOpen={graphOpen}
            onGraphOpenChange={setGraphOpen}
          />
          {graphOpen && runId ? (
            <ActiveRunDetails workspaceId={workspaceId} rootPath={rootPath} />
          ) : null}
          <Composer
            input={input}
            onInputChange={onInputChange}
            onSend={onSend}
            onAbort={onAbort}
            status={agentStatus}
            disabled={!activeSessionId || !agentReady}
            modelProfileId={workspace?.model.profileId}
            onSetModel={onSetModel}
            showStopRun={showStopRun}
            onStopRun={onStopRun}
            runBusy={runBusy}
            runNeedsOperator={runNeedsOperator}
            runStateLabel={runStateLabel}
            sessionUsage={sessionUsage}
          />
        </main>
      </div>

      {isMobile ? (
        <Sheet open={leftSheetOpen} onOpenChange={setLeftSheetOpen}>
          <SheetContent side="left" className="w-[min(100%,18rem)] p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>{t.agentWorkspace.sessions}</SheetTitle>
            </SheetHeader>
            {sessionList}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
