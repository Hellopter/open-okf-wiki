/**
 * Agent Workspace page — default home for a workspace (`/w/:id`).
 * Loads workspace + Pi agent sessions; wires the session workbench shell.
 *
 * URL: `/w/:workspaceId?sessionId=&run=&attempt=`
 * - `run` = active WikiRun SSE subscription (Active Run bar); does not open graph.
 * - `attempt` = optional node attempt dialog selection.
 * WikiRunProjectionProvider is shell-owned, keyed by `run` only.
 * `wiki_produce` receipt only updates `run` (not control facts / not graphOpen).
 * Boot / Session switch rebinds `run` from WikiRuns list `sessionId` (ADR 0026 I6).
 * `recentRuns` is the Session-scoped switcher list — not control authority.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AgentWorkbench, AgentWorkspaceShell } from "../agent-workspace/AgentWorkspaceShell";
import { isTerminalWikiRunState } from "../agent-workspace/components/run-actions";
import { removeSessionSelection } from "../agent-workspace/hooks/session-delete";
import { useAgentWorkspaceRoute } from "../agent-workspace/hooks/useAgentWorkspaceRoute";
import { useSessionAgent } from "../agent-workspace/hooks/useSessionAgent";
import {
  useWikiRunProjection,
  WikiRunProjectionProvider,
} from "../agent-workspace/hooks/WikiRunProjectionContext";
import {
  filterRunsForSession,
  pickRunForSession,
  reconcileAcceptedReceipt,
} from "../agent-workspace/hooks/workspace-route";
import {
  createAgentSession,
  deleteAgentSession,
  getWorkspace,
  listAgentSessions,
  listRuns,
  type PiSessionSummary,
  patchWorkspace,
  type WikiRunListItem,
  type WorkspaceConfig,
} from "../api";
import { LoadingState } from "../components/LoadingState";
import { useI18n } from "../i18n";

export function AgentWorkspacePage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const {
    runId: activeRunId,
    sessionId: urlSessionId,
    clearRun,
    focusRun,
    selectSession,
  } = useAgentWorkspaceRoute();

  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  // Only set after boot validates the id exists (or creates one). Starting
  // from the URL would race getAgentSession and 404 on stale sessionIds.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<WikiRunListItem[]>([]);
  const [bootError, setBootError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const bootKeyRef = useRef<string | null>(null);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  sessionsRef.current = sessions;
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const agent = useSessionAgent({
    workspaceId: id,
    sessionId: activeSessionId,
  });

  const refreshRecentRuns = useCallback(async () => {
    if (!id) return;
    try {
      const runsRes = await listRuns(id);
      if (!mountedRef.current) return;
      setRecentRuns(runsRes.runs ?? []);
    } catch {
      // best-effort list refresh — not control authority
    }
  }, [id]);

  // Event-driven recentRuns refresh: activeRunId change (new produce / clear).
  const prevActiveRunIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (loading || !workspace) return;
    const prev = prevActiveRunIdRef.current;
    prevActiveRunIdRef.current = activeRunId;
    // Skip the first observation after boot (boot already loaded the list).
    if (prev === undefined) return;
    if (prev === activeRunId) return;
    void refreshRecentRuns();
  }, [activeRunId, loading, workspace, refreshRecentRuns]);

  // Optional: refresh list when the window regains focus.
  useEffect(() => {
    if (loading || !workspace) return;
    const onFocus = () => {
      void refreshRecentRuns();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loading, workspace, refreshRecentRuns]);

  const syncSessionIdInUrl = useCallback(
    (sessionId: string) => {
      // Boot may finish after the operator has opened Sources/Wiki/Settings.
      // A stale Agent page must not navigate the now-current page back to /w/:id.
      const agentPath = `/w/${encodeURIComponent(id)}`;
      if (!mountedRef.current || window.location.pathname !== agentPath) return;
      selectSession(sessionId);
    },
    [id, selectSession],
  );

  /**
   * wiki_produce receipt only updates the `run` URL param (not control facts).
   * WikiRunStore / projection subscribe to the URL run only.
   */
  const syncRunIdInUrl = useCallback(
    (runId: string | null, attemptId?: string | null) => {
      const agentPath = `/w/${encodeURIComponent(id)}`;
      if (!mountedRef.current || window.location.pathname !== agentPath) return;
      if (runId) focusRun(runId, attemptId);
      else clearRun();
    },
    [id, focusRun, clearRun],
  );

  /**
   * Rebind `?run=` from durable WikiRuns `sessionId` links (ADR 0026 I5/I6).
   * Not message-derived — list rows carry operator_session_id from StartRun.
   */
  const rebindRunForSession = useCallback(
    (
      sessionId: string | null,
      runs: WikiRunListItem[],
      options?: { preferredRunId?: string | null; allowPreferredOutsideSession?: boolean },
    ) => {
      const nextRunId = pickRunForSession(runs, sessionId, options);
      syncRunIdInUrl(nextRunId);
    },
    [syncRunIdInUrl],
  );

  const receiptBaselineRef = useRef<string | null | undefined>(undefined);

  // Browser history and external links can change the selected Session after
  // boot. Keep the live Pi projection + linked WikiRun aligned with URL state.
  useEffect(() => {
    if (loading || !urlSessionId || urlSessionId === activeSessionId) return;
    if (sessions.some((session) => session.id === urlSessionId)) {
      activeSessionIdRef.current = urlSessionId;
      setActiveSessionId(urlSessionId);
      rebindRunForSession(urlSessionId, recentRuns, {
        preferredRunId: activeRunId,
        allowPreferredOutsideSession: false,
      });
      return;
    }
    if (activeSessionId) syncSessionIdInUrl(activeSessionId);
  }, [
    activeSessionId,
    activeRunId,
    loading,
    recentRuns,
    rebindRunForSession,
    sessions,
    syncSessionIdInUrl,
    urlSessionId,
  ]);

  useEffect(() => {
    if (!agent.ready) {
      receiptBaselineRef.current = undefined;
      return;
    }
    let latestAccepted: string | null = null;
    for (let i = agent.messages.length - 1; i >= 0; i--) {
      const msg = agent.messages[i]!;
      for (const tool of msg.tools ?? []) {
        if (tool.name !== "wiki_produce") continue;
        const details = tool.details;
        if (!details || details.status !== "accepted") continue;
        const runId = typeof details.runId === "string" ? details.runId.trim() : "";
        if (runId) {
          latestAccepted = runId;
          break;
        }
      }
      if (latestAccepted) break;
    }
    const next = reconcileAcceptedReceipt(receiptBaselineRef.current, latestAccepted);
    receiptBaselineRef.current = next.seenRunId;
    if (next.focusRunId) syncRunIdInUrl(next.focusRunId);
  }, [agent.messages, agent.ready, syncRunIdInUrl]);

  const boot = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setBootError(null);
    try {
      const wsRes = await getWorkspace(id);
      const ws = wsRes.workspace;
      setWorkspace(ws);

      const [sessRes, runsRes] = await Promise.all([
        listAgentSessions(id),
        listRuns(id).catch(() => ({ runs: [] as WikiRunListItem[] })),
      ]);

      let list = sessRes.sessions ?? [];
      let sessionId = urlSessionId ?? list[0]?.id ?? null;

      if (sessionId && !list.some((s) => s.id === sessionId)) {
        // URL id missing on disk — fall through to create/latest.
        sessionId = list[0]?.id ?? null;
      }

      if (!sessionId) {
        const created = await createAgentSession(id, {});
        list = [
          {
            id: created.session.id,
            title: created.session.title,
            updatedAt: created.session.createdAt,
          },
          ...list,
        ];
        sessionId = created.session.id;
      }

      const runs = runsRes.runs ?? [];
      sessionsRef.current = list;
      activeSessionIdRef.current = sessionId;
      setSessions(list);
      setActiveSessionId(sessionId);
      setRecentRuns(runs);
      if (sessionId) {
        syncSessionIdInUrl(sessionId);
      }
      // Refresh / re-open Session restores linked WikiRun (ADR 0026 I6).
      // Honor an explicit `?run=` deep-link when that run still exists.
      rebindRunForSession(sessionId, runs, {
        preferredRunId: activeRunId,
        allowPreferredOutsideSession: true,
      });
    } catch (err) {
      setBootError(err);
    } finally {
      setLoading(false);
    }
  }, [id, urlSessionId, activeRunId, syncSessionIdInUrl, rebindRunForSession]);

  useEffect(() => {
    if (bootKeyRef.current === id) return;
    bootKeyRef.current = id;
    prevActiveRunIdRef.current = undefined;
    receiptBaselineRef.current = undefined;
    void boot();
    // Boot once per workspace id (not on every sessionId write).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot boot
  }, [id]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      syncSessionIdInUrl(sessionId);
      // Switcher rebinds Run to this Session's linked WikiRuns only.
      rebindRunForSession(sessionId, recentRuns);
    },
    [syncSessionIdInUrl, rebindRunForSession, recentRuns],
  );

  const handleCreateSession = useCallback(async () => {
    if (!id || creating) return;
    setCreating(true);
    setBootError(null);
    try {
      const created = await createAgentSession(id, {
        title: `Wiki Agent · ${workspace?.name ?? id}`,
      });
      const summary: PiSessionSummary = {
        id: created.session.id,
        title: created.session.title,
        updatedAt: created.session.createdAt,
      };
      setSessions((prev) => {
        const next = [summary, ...prev];
        sessionsRef.current = next;
        return next;
      });
      activeSessionIdRef.current = created.session.id;
      setActiveSessionId(created.session.id);
      syncSessionIdInUrl(created.session.id);
      rebindRunForSession(created.session.id, recentRuns);
    } catch (err) {
      setBootError(err);
    } finally {
      setCreating(false);
    }
  }, [id, creating, workspace?.name, syncSessionIdInUrl, rebindRunForSession, recentRuns]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!id || deletingId) return;
      setDeletingId(sessionId);
      setBootError(null);
      try {
        await deleteAgentSession(id, sessionId);
        let { sessions: nextList, activeSessionId: nextActive } = removeSessionSelection(
          sessionsRef.current,
          sessionId,
          activeSessionIdRef.current,
        );

        if (nextList.length === 0) {
          const created = await createAgentSession(id, {});
          nextList = [
            {
              id: created.session.id,
              title: created.session.title,
              updatedAt: created.session.createdAt,
            },
          ];
          nextActive = created.session.id;
        }

        sessionsRef.current = nextList;
        activeSessionIdRef.current = nextActive;
        setSessions(nextList);
        setActiveSessionId(nextActive);
        if (nextActive) {
          syncSessionIdInUrl(nextActive);
          rebindRunForSession(nextActive, recentRuns);
        } else {
          syncRunIdInUrl(null);
        }
      } catch (err) {
        setBootError(err);
      } finally {
        setDeletingId(null);
      }
    },
    [id, deletingId, syncSessionIdInUrl, rebindRunForSession, recentRuns, syncRunIdInUrl],
  );

  // Refresh session list titles after first prompt auto-titles the active session.
  const activeListTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? "";
  const activeTitleLooksDefault = activeListTitle === `Wiki Agent · ${workspace?.name ?? id}`;
  const userMessageCount = agent.messages.filter((m) => m.role === "user").length;
  useEffect(() => {
    if (!id || !activeSessionId) return;
    if (userMessageCount < 1 || !activeTitleLooksDefault) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listAgentSessions(id)
        .then((res) => {
          if (cancelled) return;
          setSessions(res.sessions ?? []);
        })
        .catch(() => {
          // best-effort title refresh
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, activeSessionId, userMessageCount, activeTitleLooksDefault]);

  const [savingPlanConfirm, setSavingPlanConfirm] = useState(false);
  const planConfirmOn = workspace?.planConfirm === true;
  const handleTogglePlanConfirm = useCallback(
    async (next: boolean) => {
      if (!workspace || savingPlanConfirm) return;
      setSavingPlanConfirm(true);
      try {
        const result = await patchWorkspace(id, { planConfirm: next });
        setWorkspace(result.workspace);
        toast.success(next ? t.agentWorkspace.planConfirmOn : t.agentWorkspace.planConfirmOff);
      } catch (err) {
        setBootError(err);
      } finally {
        setSavingPlanConfirm(false);
      }
    },
    [id, workspace, savingPlanConfirm, t],
  );

  const toolbarActions = workspace ? (
    <div
      className="flex items-center gap-1.5"
      title={t.settings.planConfirmHint}
      data-testid="agent-plan-confirm"
    >
      <Label
        htmlFor="agent-plan-confirm-switch"
        className="text-xs font-normal text-muted-foreground"
      >
        {t.settings.planConfirm}
      </Label>
      <Switch
        id="agent-plan-confirm-switch"
        size="sm"
        checked={planConfirmOn}
        disabled={savingPlanConfirm}
        onCheckedChange={(checked) => void handleTogglePlanConfirm(checked === true)}
        data-testid="agent-plan-confirm-switch"
      />
    </div>
  ) : undefined;

  if (loading || !workspace) {
    return (
      <AgentWorkbench
        workspaceId={id}
        workspaceName={workspace?.name}
        toolbarActions={toolbarActions}
        error={bootError}
        onDismissError={() => setBootError(null)}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <LoadingState label={t.agentWorkspace.loading} />
        </div>
      </AgentWorkbench>
    );
  }

  const sessionRuns = filterRunsForSession(recentRuns, activeSessionId, activeRunId);

  return (
    <WikiRunProjectionProvider workspaceId={id} runId={activeRunId}>
      <AgentWorkspaceShellWithRunChrome
        workspaceId={id}
        workspace={workspace}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={() => void handleCreateSession()}
        onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
        creatingSession={creating}
        deletingSessionId={deletingId}
        agent={agent}
        recentRuns={sessionRuns}
        activeRunId={activeRunId}
        onRefreshRecentRuns={refreshRecentRuns}
        pageError={bootError}
        onDismissPageError={() => setBootError(null)}
        toolbarActions={toolbarActions}
      />
    </WikiRunProjectionProvider>
  );
}

type AgentWorkspaceShellWithRunChromeProps = {
  workspaceId: string;
  workspace: WorkspaceConfig;
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  creatingSession: boolean;
  deletingSessionId: string | null;
  agent: ReturnType<typeof useSessionAgent>;
  recentRuns: WikiRunListItem[];
  activeRunId: string | null;
  onRefreshRecentRuns: () => Promise<void>;
  pageError?: unknown;
  onDismissPageError?: () => void;
  toolbarActions?: ReactNode;
};

/**
 * Reads the shell WikiRun projection (inside provider) for dual-surface chrome
 * and event-driven recentRuns refresh on terminal live state.
 * Active run is URL-owned (`?run=`); projection subscribes to that run only.
 */
function AgentWorkspaceShellWithRunChrome({
  workspaceId,
  workspace,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  creatingSession,
  deletingSessionId,
  agent,
  recentRuns,
  activeRunId,
  onRefreshRecentRuns,
  pageError,
  onDismissPageError,
  toolbarActions,
}: AgentWorkspaceShellWithRunChromeProps) {
  const projection = useWikiRunProjection();

  // Refresh recentRuns when live snapshot enters a terminal state.
  const terminalRefreshKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const snap = projection.snapshot;
    if (!snap || snap.runId !== activeRunId) return;
    if (!isTerminalWikiRunState(snap.state)) {
      terminalRefreshKeyRef.current = null;
      return;
    }
    const key = `${snap.runId}:${snap.state}:${snap.revision}`;
    if (terminalRefreshKeyRef.current === key) return;
    terminalRefreshKeyRef.current = key;
    void onRefreshRecentRuns();
  }, [projection.snapshot, activeRunId, onRefreshRecentRuns]);

  return (
    <AgentWorkspaceShell
      workspaceId={workspaceId}
      workspace={workspace}
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={onSelectSession}
      onCreateSession={onCreateSession}
      onDeleteSession={onDeleteSession}
      creatingSession={creatingSession}
      deletingSessionId={deletingSessionId}
      messages={agent.messages}
      input={agent.input}
      onInputChange={agent.setInput}
      onSend={() => void agent.send()}
      onAbort={() => void agent.abort()}
      onSetModel={agent.setModel}
      agentStatus={agent.status}
      agentReady={agent.ready}
      connectionStatus={agent.connectionStatus}
      agentError={agent.error}
      onDismissAgentError={agent.clearError}
      recentRuns={recentRuns}
      sessionUsage={agent.sessionUsage}
      pageError={pageError}
      onDismissPageError={onDismissPageError}
      toolbarActions={toolbarActions}
    />
  );
}
