/**
 * Agent Workspace page — default home for a workspace (`/w/:id`).
 * Loads workspace + Pi agent sessions; wires the session workbench shell.
 *
 * URL: `/w/:workspaceId?sessionId=&run=&attempt=`
 * - `run` = active WikiRun SSE subscription (Active Run bar); does not open graph.
 * - `attempt` = optional node attempt dialog selection.
 * WikiRunProjectionProvider is shell-owned, keyed by `run` only.
 * `wiki_produce` receipt only updates `run` (not control facts / not graphOpen).
 * `recentRuns` is list refresh for the bar switcher — not control authority.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AgentWorkbench, AgentWorkspaceShell } from "../agent-workspace/AgentWorkspaceShell";
import {
  type ActiveRunChrome,
  deriveOperatorChrome,
  TERMINAL_WIKI_RUN_STATES,
} from "../agent-workspace/hooks/derive-operator-chrome";
import {
  WikiRunProjectionProvider,
  useWikiRunProjection,
} from "../agent-workspace/hooks/WikiRunProjectionContext";
import { useSessionAgent } from "../agent-workspace/hooks/useSessionAgent";
import { openGatesFromSnapshot } from "../agent-workspace/run-graph/wiki-run-view-model";
import {
  createAgentSession,
  deleteAgentSession,
  dispatchWikiRunCommand,
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
  const [searchParams, setSearchParams] = useSearchParams();

  const urlRun = searchParams.get("run");
  const urlSessionId = searchParams.get("sessionId");

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // rootPath is for API optional args only — never required in the URL.
  const rootPath = workspace?.rootPath;

  const agent = useSessionAgent({
    workspaceId: id,
    sessionId: activeSessionId,
    rootPath,
  });

  const activeRunId = urlRun;

  const refreshRecentRuns = useCallback(async () => {
    if (!id || !rootPath) return;
    try {
      const runsRes = await listRuns(id, rootPath);
      if (!mountedRef.current) return;
      setRecentRuns(runsRes.runs ?? []);
    } catch {
      // best-effort list refresh — not control authority
    }
  }, [id, rootPath]);

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
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          // Drop legacy rootPath query if present; navigation is id-only.
          next.delete("rootPath");
          next.set("sessionId", sessionId);
          return next;
        },
        { replace: true },
      );
    },
    [id, setSearchParams],
  );

  /**
   * wiki_produce receipt only updates the `run` URL param (not control facts).
   * WikiRunStore / projection subscribe to the URL run only.
   */
  const syncRunIdInUrl = useCallback(
    (runId: string, attemptId?: string | null) => {
      const agentPath = `/w/${encodeURIComponent(id)}`;
      if (!mountedRef.current || window.location.pathname !== agentPath) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("rootPath");
          if (prev.get("run") === runId) {
            if (attemptId) {
              if (prev.get("attempt") === attemptId) return prev;
              next.set("attempt", attemptId);
              return next;
            }
            if (!prev.has("attempt")) return prev;
            next.delete("attempt");
            return next;
          }
          next.set("run", runId);
          if (attemptId) next.set("attempt", attemptId);
          else next.delete("attempt");
          return next;
        },
        { replace: true },
      );
    },
    [id, setSearchParams],
  );

  // Receipt → URL only: a *new* accepted wiki_produce updates `run` (not control facts).
  // Do not re-apply historical receipts over an operator-selected list run.
  const lastReceiptRunIdRef = useRef<string | null>(null);

  // Browser history and external links can change the selected Session after
  // boot. Keep the live Pi projection aligned with the validated URL state.
  useEffect(() => {
    if (loading || !urlSessionId || urlSessionId === activeSessionId) return;
    if (sessions.some((session) => session.id === urlSessionId)) {
      lastReceiptRunIdRef.current = null;
      setActiveSessionId(urlSessionId);
      return;
    }
    if (activeSessionId) syncSessionIdInUrl(activeSessionId);
  }, [activeSessionId, loading, sessions, syncSessionIdInUrl, urlSessionId]);

  useEffect(() => {
    if (!agent.messages.length) return;
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
    if (!latestAccepted) return;
    if (lastReceiptRunIdRef.current === latestAccepted) return;
    lastReceiptRunIdRef.current = latestAccepted;
    if (latestAccepted !== urlRun) {
      syncRunIdInUrl(latestAccepted);
    }
  }, [agent.messages, urlRun, syncRunIdInUrl]);

  const boot = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setBootError(null);
    try {
      const wsRes = await getWorkspace(id);
      const ws = wsRes.workspace;
      setWorkspace(ws);
      const root = ws.rootPath;

      const [sessRes, runsRes] = await Promise.all([
        listAgentSessions(id, root),
        listRuns(id, root).catch(() => ({ runs: [] as WikiRunListItem[] })),
      ]);

      let list = sessRes.sessions ?? [];
      let sessionId = searchParams.get("sessionId") ?? list[0]?.id ?? null;

      if (sessionId && !list.some((s) => s.id === sessionId)) {
        // URL id missing on disk — fall through to create/latest.
        sessionId = list[0]?.id ?? null;
      }

      if (!sessionId) {
        const created = await createAgentSession(id, {}, root);
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

      setSessions(list);
      setActiveSessionId(sessionId);
      setRecentRuns(runsRes.runs ?? []);
      if (sessionId) {
        syncSessionIdInUrl(sessionId);
      }
    } catch (err) {
      setBootError(err);
    } finally {
      setLoading(false);
    }
  }, [id, searchParams, syncSessionIdInUrl]);

  useEffect(() => {
    if (bootKeyRef.current === id) return;
    bootKeyRef.current = id;
    prevActiveRunIdRef.current = undefined;
    lastReceiptRunIdRef.current = null;
    void boot();
    // Boot once per workspace id (not on every sessionId write).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot boot
  }, [id]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      lastReceiptRunIdRef.current = null;
      syncSessionIdInUrl(sessionId);
    },
    [syncSessionIdInUrl],
  );

  const handleCreateSession = useCallback(async () => {
    if (!id || creating) return;
    setCreating(true);
    setBootError(null);
    try {
      const created = await createAgentSession(
        id,
        { title: `Wiki Agent · ${workspace?.name ?? id}` },
        rootPath,
      );
      const summary: PiSessionSummary = {
        id: created.session.id,
        title: created.session.title,
        updatedAt: created.session.createdAt,
      };
      setSessions((prev) => [summary, ...prev]);
      setActiveSessionId(created.session.id);
      syncSessionIdInUrl(created.session.id);
    } catch (err) {
      setBootError(err);
    } finally {
      setCreating(false);
    }
  }, [id, creating, workspace?.name, rootPath, syncSessionIdInUrl]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!id || deletingId) return;
      setDeletingId(sessionId);
      setBootError(null);
      try {
        await deleteAgentSession(id, sessionId, rootPath);
        let nextList = sessions.filter((s) => s.id !== sessionId);
        let nextActive = activeSessionId === sessionId ? null : activeSessionId;

        if (nextList.length === 0) {
          const created = await createAgentSession(id, {}, rootPath);
          nextList = [
            {
              id: created.session.id,
              title: created.session.title,
              updatedAt: created.session.createdAt,
            },
          ];
          nextActive = created.session.id;
        } else if (!nextActive || !nextList.some((s) => s.id === nextActive)) {
          nextActive = nextList[0]!.id;
        }

        setSessions(nextList);
        setActiveSessionId(nextActive);
        if (nextActive) syncSessionIdInUrl(nextActive);
      } catch (err) {
        setBootError(err);
      } finally {
        setDeletingId(null);
      }
    },
    [id, deletingId, rootPath, sessions, activeSessionId, syncSessionIdInUrl],
  );

  // Refresh session list titles after first prompt auto-titles the active session.
  const activeListTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? "";
  const activeTitleLooksDefault = activeListTitle === `Wiki Agent · ${workspace?.name ?? id}`;
  const userMessageCount = agent.messages.filter((m) => m.role === "user").length;
  useEffect(() => {
    if (!id || !activeSessionId || !rootPath) return;
    if (userMessageCount < 1 || !activeTitleLooksDefault) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listAgentSessions(id, rootPath)
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
  }, [id, activeSessionId, rootPath, userMessageCount, activeTitleLooksDefault]);

  const [savingPlanConfirm, setSavingPlanConfirm] = useState(false);
  const planConfirmOn = workspace?.planConfirm === true;
  const handleTogglePlanConfirm = useCallback(
    async (next: boolean) => {
      if (!workspace || savingPlanConfirm) return;
      setSavingPlanConfirm(true);
      try {
        const result = await patchWorkspace(id, { planConfirm: next }, workspace.rootPath);
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

  return (
    <WikiRunProjectionProvider workspaceId={id} rootPath={rootPath} runId={activeRunId}>
      <AgentWorkspaceShellWithRunChrome
        workspaceId={id}
        rootPath={rootPath}
        workspace={workspace}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={() => void handleCreateSession()}
        onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
        creatingSession={creating}
        deletingSessionId={deletingId}
        agent={agent}
        recentRuns={recentRuns}
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
  rootPath?: string;
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
  rootPath,
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
    if (!TERMINAL_WIKI_RUN_STATES.has(snap.state)) {
      terminalRefreshKeyRef.current = null;
      return;
    }
    const key = `${snap.runId}:${snap.state}:${snap.revision}`;
    if (terminalRefreshKeyRef.current === key) return;
    terminalRefreshKeyRef.current = key;
    void onRefreshRecentRuns();
  }, [projection.snapshot, activeRunId, onRefreshRecentRuns]);

  const activeRunChrome: ActiveRunChrome | null = useMemo(() => {
    if (!activeRunId) return null;
    const snapshot =
      projection.snapshot?.runId === activeRunId ? projection.snapshot : null;
    if (snapshot) {
      return {
        runId: activeRunId,
        state: snapshot.state,
        openGateKinds: openGatesFromSnapshot(snapshot).map((gate) => gate.kind),
        hasRunningAttempt: snapshot.attempts.some((attempt) => attempt.state === "running"),
      };
    }
    const listed = recentRuns.find((run) => run.runId === activeRunId);
    if (listed) {
      return { runId: activeRunId, state: listed.state };
    }
    // Receipt accepted but list/snapshot not yet loaded — treat as queued so Stop run appears.
    return { runId: activeRunId, state: "queued" };
  }, [activeRunId, projection.snapshot, recentRuns]);

  const operatorChrome = useMemo(
    () =>
      deriveOperatorChrome({
        sessionStatus: agent.status,
        activeRun: activeRunChrome,
      }),
    [agent.status, activeRunChrome],
  );

  const handleStopRun = useCallback(() => {
    if (!workspaceId || !activeRunId) return;
    void dispatchWikiRunCommand(
      workspaceId,
      {
        type: "cancel_run",
        commandId: crypto.randomUUID(),
        runId: activeRunId,
      },
      rootPath,
    ).catch((err) => {
      // Surface as a toast; Run SSE will still advance if cancel eventually applies.
      toast.error(err instanceof Error ? err.message : String(err));
    });
  }, [workspaceId, activeRunId, rootPath]);

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
      showStopRun={operatorChrome.showStopRun}
      onStopRun={handleStopRun}
      runBusy={operatorChrome.runBusy}
      runNeedsOperator={operatorChrome.runNeedsOperator}
      runStateLabel={operatorChrome.runStatusLabel}
      sessionUsage={agent.sessionUsage}
      pageError={pageError}
      onDismissPageError={onDismissPageError}
      toolbarActions={toolbarActions}
    />
  );
}
