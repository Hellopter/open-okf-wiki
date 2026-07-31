/**
 * Operate-route workbench.
 *
 * This is the only full-height owner for `/w/:id`. Session and WikiRun SSE
 * projections stay page-owned; this file only composes their UI surfaces.
 */

import type { SessionUsage } from "@okf-wiki/contract";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { PiSessionSummary, WikiRunListItem, WorkspaceConfig } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { useI18n } from "../i18n";
import { ActiveRunBar } from "./components/ActiveRunBar";
import { RunCockpit } from "./components/RunCockpit";
import { RunPicker } from "./components/RunPicker";
import { Composer } from "./composer/Composer";
import { useAgentWorkspaceRoute } from "./hooks/useAgentWorkspaceRoute";
import type { AgentMessage, AgentStatus, ConnectionStatus } from "./hooks/useSessionAgent";
import { AgentSessionSidebar } from "./session-list/SessionList";
import { Transcript } from "./transcript/Transcript";

export type WorkspaceToolbarProps = {
  workspaceId: string;
  workspaceName?: string;
  connectionStatus?: ConnectionStatus;
  runControls?: ReactNode;
  actions?: ReactNode;
};

function connectionLabel(status: ConnectionStatus, t: ReturnType<typeof useI18n>["t"]): string {
  switch (status) {
    case "live":
      return t.agentWorkspace.connectionLive;
    case "connecting":
      return t.agentWorkspace.connectionConnecting;
    case "reconnecting":
      return t.agentWorkspace.connectionReconnecting;
    case "offline":
      return t.agentWorkspace.connectionOffline;
  }
}

function connectionVariant(status: ConnectionStatus): "secondary" | "outline" | "destructive" {
  if (status === "live") return "secondary";
  if (status === "offline") return "destructive";
  return "outline";
}

/** The single Operate header; mobile no longer renders a second session header. */
export function WorkspaceToolbar({
  workspaceId,
  workspaceName,
  connectionStatus = "offline",
  runControls,
  actions,
}: WorkspaceToolbarProps) {
  const { t } = useI18n();
  const displayName = workspaceName ?? workspaceId;

  return (
    <header
      className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1 md:px-3"
      data-testid="workspace-toolbar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SidebarTrigger data-testid="agent-mobile-sessions" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            <BreadcrumbItem className="hidden sm:inline-flex">
              <BreadcrumbLink render={<Link to="/workspaces" />}>{t.nav.workspaces}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden sm:inline-flex" />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="block max-w-48 truncate sm:max-w-80">
                {displayName}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {runControls ? (
        <div className="flex shrink-0 items-center gap-1" data-testid="workspace-run-controls">
          {runControls}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant={connectionVariant(connectionStatus)}
          aria-live="polite"
          data-testid="agent-connection-status"
          data-connection-status={connectionStatus}
        >
          {connectionLabel(connectionStatus, t)}
        </Badge>
        {actions}
      </div>
    </header>
  );
}

export type AgentWorkbenchProps = {
  workspaceId: string;
  workspaceName?: string;
  connectionStatus?: ConnectionStatus;
  runControls?: ReactNode;
  toolbarActions?: ReactNode;
  sidebar?: ReactNode;
  error?: unknown;
  onDismissError?: () => void;
  children: ReactNode;
  className?: string;
};

/**
 * Full replacement for WorkbenchShell on the Operate route.
 * SidebarProvider must stay at this level because Sidebar owns a fixed h-svh
 * desktop container and its own mobile Sheet.
 */
export function AgentWorkbench({
  workspaceId,
  workspaceName,
  connectionStatus = "offline",
  runControls,
  toolbarActions,
  sidebar,
  error,
  onDismissError,
  children,
  className,
}: AgentWorkbenchProps) {
  const { t } = useI18n();
  const sidebarLabels = useMemo(
    () => ({
      mobileTitle: t.agentWorkspace.sessions,
      mobileDescription: t.agentWorkspace.mobileSessionsDescription,
      toggleLabel: t.agentWorkspace.toggleSessions,
      expandLabel: t.agentWorkspace.expandSessions,
      collapseLabel: t.agentWorkspace.collapseSessions,
    }),
    [
      t.agentWorkspace.collapseSessions,
      t.agentWorkspace.expandSessions,
      t.agentWorkspace.mobileSessionsDescription,
      t.agentWorkspace.sessions,
      t.agentWorkspace.toggleSessions,
    ],
  );

  return (
    <SidebarProvider
      className={cn("h-svh min-h-0 overflow-hidden", className)}
      labels={sidebarLabels}
      data-testid="agent-workspace-page"
    >
      {sidebar}
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <WorkspaceToolbar
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          connectionStatus={connectionStatus}
          runControls={runControls}
          actions={toolbarActions}
        />
        {error ? (
          <div className="shrink-0 px-3 pt-2">
            <ErrorBanner error={error} onDismiss={onDismissError} />
          </div>
        ) : null}
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
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
  onSetModel?: (profileId: string) => Promise<boolean>;
  agentStatus: AgentStatus;
  agentReady: boolean;
  connectionStatus?: ConnectionStatus;
  agentError?: unknown;
  onDismissAgentError?: () => void;
  recentRuns?: WikiRunListItem[];
  sessionUsage?: SessionUsage | null;
  pageError?: unknown;
  onDismissPageError?: () => void;
  toolbarActions?: ReactNode;
  className?: string;
};

/** Fill styles for react-resizable-panels v4 inner wrappers (see split layout below). */
const RESIZABLE_PANEL_FILL_STYLE = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
} as const;

function useWideDesktop() {
  const [isWide, setIsWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setIsWide(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  return isWide;
}

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
  sessionUsage = null,
  pageError,
  onDismissPageError,
  toolbarActions,
  className,
}: AgentWorkspaceShellProps) {
  const { t } = useI18n();
  const { attemptId, runId, selectAttempt, selectRun } = useAgentWorkspaceRoute();
  const isMobile = useIsMobile();
  const isWideDesktop = useWideDesktop();
  const [cockpitOpen, setCockpitOpen] = useState(false);

  useEffect(() => {
    if (attemptId) setCockpitOpen(true);
  }, [attemptId]);

  const cockpitLabel = cockpitOpen ? t.runInspector.close : t.runInspector.open;
  const runControls = runId ? (
    <>
      <RunPicker runId={runId} recentRuns={recentRuns} onSelectRun={selectRun} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={cockpitLabel}
              aria-pressed={cockpitOpen}
              data-testid="active-run-toggle-graph"
              onClick={() => setCockpitOpen((open) => !open)}
            />
          }
        >
          {cockpitOpen ? (
            <PanelRightCloseIcon data-icon="inline-start" />
          ) : (
            <PanelRightOpenIcon data-icon="inline-start" />
          )}
          <span className="sr-only">{cockpitLabel}</span>
        </TooltipTrigger>
        <TooltipContent>{cockpitLabel}</TooltipContent>
      </Tooltip>
    </>
  ) : null;

  // h-full is required when this tree sits inside react-resizable-panels v4:
  // the library's inner panel wrapper is not a flex column, so flex-1 alone
  // collapses to content height and the composer jumps up under the transcript.
  const conversationPanel = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <Transcript messages={messages} />
      <div className="shrink-0" data-testid="agent-action-dock">
        <ActiveRunBar
          workspaceId={workspaceId}
          runId={runId}
          onSelectRun={selectRun}
          recentRuns={recentRuns}
          graphOpen={cockpitOpen}
          onGraphOpenChange={setCockpitOpen}
          showRunPicker={false}
          showInspectorTrigger={false}
        />
        <Composer
          input={input}
          onInputChange={onInputChange}
          onSend={onSend}
          onAbort={onAbort}
          status={agentStatus}
          disabled={!activeSessionId || !agentReady}
          modelProfileId={workspace?.model.profileId}
          onSetModel={onSetModel}
          sessionUsage={sessionUsage}
        />
      </div>
    </div>
  );

  const cockpit = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="active-run-details">
      <RunCockpit
        key={runId}
        workspaceId={workspaceId}
        runId={runId}
        attemptId={attemptId}
        onSelectAttempt={selectAttempt}
        onClose={() => setCockpitOpen(false)}
      />
    </div>
  );

  return (
    <AgentWorkbench
      workspaceId={workspaceId}
      workspaceName={workspace?.name}
      connectionStatus={connectionStatus}
      runControls={runControls}
      toolbarActions={toolbarActions}
      error={pageError}
      onDismissError={onDismissPageError}
      sidebar={
        <AgentSessionSidebar
          workspaceId={workspaceId}
          workspaceName={workspace?.name}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={onSelectSession}
          onCreate={onCreateSession}
          onDelete={onDeleteSession}
          creating={creatingSession}
          deletingId={deletingSessionId}
        />
      }
    >
      <div
        data-testid="agent-workspace-shell"
        data-connection-status={connectionStatus}
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", className)}
      >
        {agentError ? (
          <div className="shrink-0 px-3 pt-2">
            <ErrorBanner error={agentError} onDismiss={onDismissAgentError} />
          </div>
        ) : null}

        {isWideDesktop && cockpitOpen && runId ? (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
            {/*
              v4 Panel paints overflow:auto on its inner wrapper and is not a
              flex column. Override so children can use h-full/flex-1, the
              transcript scrolls internally, and the composer stays bottom.
            */}
            <ResizablePanel
              defaultSize={68}
              minSize={45}
              className="min-h-0"
              style={RESIZABLE_PANEL_FILL_STYLE}
            >
              {conversationPanel}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={32}
              minSize={24}
              className="min-h-0"
              style={RESIZABLE_PANEL_FILL_STYLE}
            >
              {cockpit}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          conversationPanel
        )}
      </div>

      {!isWideDesktop && cockpitOpen && runId && !isMobile ? (
        <Sheet open={cockpitOpen} onOpenChange={setCockpitOpen}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="w-[min(100%,34rem)] max-w-none gap-0 p-0"
            data-testid="run-cockpit-sheet"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t.runInspector.title}</SheetTitle>
            </SheetHeader>
            {cockpit}
          </SheetContent>
        </Sheet>
      ) : null}

      {!isWideDesktop && cockpitOpen && runId && isMobile ? (
        <Drawer open={cockpitOpen} onOpenChange={setCockpitOpen} showSwipeHandle>
          <DrawerContent
            className="pb-[env(safe-area-inset-bottom)]"
            data-testid="run-cockpit-drawer"
          >
            <DrawerHeader className="sr-only">
              <DrawerTitle>{t.runInspector.title}</DrawerTitle>
            </DrawerHeader>
            {cockpit}
          </DrawerContent>
        </Drawer>
      ) : null}
    </AgentWorkbench>
  );
}
