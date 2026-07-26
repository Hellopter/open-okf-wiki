/**
 * Agent Workspace 3-pane shell (ADR 0032).
 *
 * left: session list · center: transcript + composer · right: context panels
 *
 * Desktop: both side panes collapse to a thin rail (localStorage), so the
 * transcript can claim width for code / mermaid / math. Mobile: sheets.
 */

import type { AgentResumeGateCommand } from "@okf-wiki/contract";
import { LayoutListIcon, PanelRightIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { PiSessionSummary, StoredRunRecord, WorkspaceConfig } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { useI18n } from "../i18n";
import { Composer } from "./composer/Composer";
import type { AgentMessage, AgentStatus, ConnectionStatus } from "./hooks/useSessionAgent";
import { ContextPanels } from "./panels/ContextPanels";
import { SessionList } from "./session-list/SessionList";
import { Transcript } from "./transcript/Transcript";

const CONNECTION_TOAST_ID = "agent-connection-status";

/** localStorage: "1" = collapsed, "0" / missing = expanded. */
const LEFT_STORAGE_KEY = "okf-wiki.agent.left-collapsed";
const RIGHT_STORAGE_KEY = "okf-wiki.agent.right-collapsed";

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
  onResumeGate: (command: AgentResumeGateCommand) => Promise<void>;
  /** Session-scoped chat model switch (composer dropdown). */
  onSetModel?: (profileId: string) => Promise<boolean>;
  agentStatus: AgentStatus;
  agentReady: boolean;
  /** SSE lifecycle — only degraded states paint chrome; live is silent. */
  connectionStatus?: ConnectionStatus;
  agentError?: unknown;
  onDismissAgentError?: () => void;
  recentRuns?: StoredRunRecord[];
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
  onResumeGate,
  onSetModel,
  agentStatus,
  agentReady,
  connectionStatus = "offline",
  agentError,
  onDismissAgentError,
  recentRuns = [],
  className,
}: AgentWorkspaceShellProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [leftSheetOpen, setLeftSheetOpen] = useState(false);
  const [rightSheetOpen, setRightSheetOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(() => readCollapsed(LEFT_STORAGE_KEY, false));
  const [rightCollapsed, setRightCollapsed] = useState(() =>
    readCollapsed(RIGHT_STORAGE_KEY, false),
  );

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

  const toggleRight = useCallback(() => {
    setRightCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(RIGHT_STORAGE_KEY, next);
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

  const contextPanels = (
    <ContextPanels
      workspaceId={workspaceId}
      workspace={workspace}
      recentRuns={recentRuns}
      onCollapse={!isMobile ? toggleRight : undefined}
    />
  );

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
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t.agentWorkspace.panels}
            title={t.agentWorkspace.panels}
            onClick={() => setRightSheetOpen(true)}
            data-testid="agent-mobile-panels"
          >
            <PanelRightIcon />
            <span className="sr-only">{t.agentWorkspace.panels}</span>
          </Button>
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
          <Transcript messages={messages} onResumeGate={onResumeGate} />
          <Composer
            input={input}
            onInputChange={onInputChange}
            onSend={onSend}
            onAbort={onAbort}
            status={agentStatus}
            disabled={!activeSessionId || !agentReady}
            modelProfileId={workspace?.model.profileId}
            onSetModel={onSetModel}
          />
        </main>

        {!isMobile ? (
          rightCollapsed ? (
            <aside
              data-testid="agent-right-rail"
              data-collapsed="true"
              className="flex w-10 shrink-0 flex-col items-center border-l border-border bg-muted/20 py-2"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t.agentWorkspace.expandPanels}
                      aria-expanded={false}
                      data-testid="agent-right-expand"
                      onClick={toggleRight}
                    />
                  }
                >
                  <PanelRightIcon />
                </TooltipTrigger>
                <TooltipContent side="left">{t.agentWorkspace.expandPanels}</TooltipContent>
              </Tooltip>
            </aside>
          ) : (
            <aside
              data-testid="agent-right-pane"
              data-collapsed="false"
              className="flex w-60 shrink-0 flex-col border-l border-border lg:w-64"
            >
              {contextPanels}
            </aside>
          )
        ) : null}
      </div>

      {isMobile ? (
        <>
          <Sheet open={leftSheetOpen} onOpenChange={setLeftSheetOpen}>
            <SheetContent side="left" className="w-[min(100%,18rem)] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{t.agentWorkspace.sessions}</SheetTitle>
              </SheetHeader>
              {sessionList}
            </SheetContent>
          </Sheet>
          <Sheet open={rightSheetOpen} onOpenChange={setRightSheetOpen}>
            <SheetContent side="right" className="w-[min(100%,20rem)] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{t.agentWorkspace.panels}</SheetTitle>
              </SheetHeader>
              {contextPanels}
            </SheetContent>
          </Sheet>
        </>
      ) : null}
    </div>
  );
}
