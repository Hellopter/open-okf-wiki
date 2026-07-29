/**
 * Agent Workspace page — default home for a workspace (`/w/:id`).
 * Loads workspace + Pi agent sessions; wires the 3-pane shell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AgentWorkspaceShell } from "../agent-workspace/AgentWorkspaceShell";
import {
  type ActiveRunChrome,
  deriveOperatorChrome,
  resolveActiveRunId,
} from "../agent-workspace/hooks/derive-operator-chrome";
import { useSessionAgent } from "../agent-workspace/hooks/useSessionAgent";
import { useWikiRun } from "../agent-workspace/hooks/useWikiRun";
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
import { WorkbenchShell } from "../shells/WorkbenchShell";

export function AgentWorkspacePage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

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

  /** Latest accepted wiki_produce runId and/or non-terminal recentRuns entry. */
  const activeRunId = useMemo(
    () => resolveActiveRunId({ messages: agent.messages, recentRuns }),
    [agent.messages, recentRuns],
  );

  const activeWikiRun = useWikiRun({
    workspaceId: id,
    runId: activeRunId,
    rootPath,
    enabled: Boolean(activeRunId),
  });

  const activeRunChrome: ActiveRunChrome | null = useMemo(() => {
    if (!activeRunId) return null;
    const snapshot =
      activeWikiRun.snapshot?.runId === activeRunId ? activeWikiRun.snapshot : null;
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
  }, [activeRunId, activeWikiRun.snapshot, recentRuns]);

  const operatorChrome = useMemo(
    () =>
      deriveOperatorChrome({
        sessionStatus: agent.status,
        activeRun: activeRunChrome,
      }),
    [agent.status, activeRunChrome],
  );

  const handleStopRun = useCallback(() => {
    if (!id || !activeRunId) return;
    void dispatchWikiRunCommand(
      id,
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
  }, [id, activeRunId, rootPath]);

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
    void boot();
    // Boot once per workspace id (not on every sessionId write).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot boot
  }, [id]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
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

  return (
    <WorkbenchShell
      workspaceId={id}
      workspaceName={workspace?.name}
      mode="operate"
      error={bootError}
      onDismissError={() => setBootError(null)}
      immersive
      testId="agent-workspace-page"
      statusSlot={
        workspace ? (
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
        ) : undefined
      }
    >
      {loading || !workspace ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <LoadingState label={t.agentWorkspace.loading} />
        </div>
      ) : (
        <AgentWorkspaceShell
          workspaceId={id}
          workspace={workspace}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onCreateSession={() => void handleCreateSession()}
          onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          creatingSession={creating}
          deletingSessionId={deletingId}
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
        />
      )}
    </WorkbenchShell>
  );
}
