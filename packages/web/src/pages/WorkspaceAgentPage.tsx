import type { RunCommand, WikiRunAttempt, WikiRunSnapshot } from "@okf-wiki/contract";
import { LanguagesIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConversationPanel } from "../agent-workspace/ConversationPanel";
import { RunCanvas } from "../agent-workspace/RunCanvas";
import { sessionRunLinks } from "../agent-workspace/session-run-links";
import { useSessionConversation } from "../agent-workspace/useSessionConversation";
import { useWorkspaceActivity } from "../agent-workspace/useWorkspaceActivity";
import { WorkbenchActivitySidebar } from "../agent-workspace/WorkbenchActivitySidebar";
import { promptTitle } from "../agent-workspace/workbench-utils";
import { dispatchWikiRunCommand, getWikiRun } from "../api";
import { LoadingState } from "../components/LoadingState";
import { formatMessage, useI18n } from "../i18n";
import { notifyError, notifySuccess } from "../lib/notify";
import { AttemptObservation } from "../run-workspace/AttemptObservation";
import { latestAttemptForNode } from "../run-workspace/observation-state";
import { useRunObservation } from "../run-workspace/useRunObservation";
import { type WorkflowStageId, workflowStageIds } from "../run-workspace/workflow-topology";
import { WorkbenchShell } from "../shells/WorkbenchShell";

type Surface = "conversation" | "run" | "observation";

export function WorkspaceAgentPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const [surface, setSurface] = useState<Surface>(
    params.get("attempt") ? "observation" : params.get("run") ? "run" : "conversation",
  );
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("okf-wiki:workbench-timeline-collapsed") === "true",
  );
  const { t, locale, setLocale } = useI18n();
  const activeSessionId = params.get("session");
  const activeRunId = params.get("run");
  const activeAttemptId = params.get("attempt");
  const stageParam = params.get("stage");
  const graphStage =
    stageParam && workflowStageIds.includes(stageParam as WorkflowStageId)
      ? (stageParam as WorkflowStageId)
      : null;

  const updateSelection = useCallback(
    (next: {
      session?: string | null;
      run?: string | null;
      attempt?: string | null;
      stage?: WorkflowStageId | null;
    }) => {
      const copy = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) copy.set(key, value);
        else copy.delete(key);
      }
      setParams(copy, { replace: true });
    },
    [params, setParams],
  );

  const selectInitialSession = useCallback(
    (sessionId: string) => {
      updateSelection({ session: sessionId });
    },
    [updateSelection],
  );

  const activity = useWorkspaceActivity({
    workspaceId: id,
    activeSessionId,
    onSelectInitialSession: selectInitialSession,
  });
  const workspaceDefaultProfileId = activity.workspace?.model?.profileId ?? null;
  const conversation = useSessionConversation(id, activeSessionId, {
    defaultProfileId: workspaceDefaultProfileId,
  });
  const observation = useRunObservation(id, activeRunId, activeAttemptId);
  const {
    snapshot,
    spec,
    planReview,
    planReviewStatus,
    planReviewRetry,
    selectedAttempt,
    selectedNode,
    timeline,
  } = observation;
  const planReviewState = {
    status: planReviewStatus,
    review: planReview,
    error: null as unknown,
    expectedPayloadDigest:
      snapshot?.gates.find((g) => g.state === "open" && g.kind === "plan")?.payloadDigest ??
      planReview?.payloadDigest ??
      null,
    retry: planReviewRetry,
  };
  const selectedNodeKey = selectedNode?.key ?? null;
  const activeSessionRuns = sessionRunLinks(activity.runs, activeSessionId);
  const activeConnection =
    surface === "conversation" ? conversation.connection : observation.connection;

  useEffect(() => {
    window.localStorage.setItem("okf-wiki:workbench-timeline-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const createSession = async () => {
    const created = await activity.createSession();
    if (!created) return;
    updateSelection({ session: created.id, run: null, attempt: null });
    setSurface("conversation");
  };

  const dispatchRun = async (build: (current: WikiRunSnapshot) => RunCommand) => {
    if (!id || !snapshot) return;
    try {
      const latest = (await getWikiRun(id, snapshot.runId)).snapshot;
      await dispatchWikiRunCommand(id, build(latest));
      notifySuccess(t.workbench.runCommandAccepted);
    } catch (nextError) {
      notifyError(nextError);
    }
  };

  const selectSession = (sessionId: string) => {
    updateSelection({ session: sessionId });
    setSurface("conversation");
    setSidebarOpen(false);
  };
  const selectRun = (runId: string) => {
    updateSelection({ run: runId, attempt: null, stage: null });
    setSurface("run");
    setSidebarOpen(false);
  };
  const deleteSession = async (sessionId: string) => {
    const nextSessions = await activity.removeSession(sessionId);
    if (!nextSessions || sessionId !== activeSessionId) return;
    updateSelection({ session: nextSessions[0]?.id ?? null });
  };
  const selectNode = (nodeKey: string) => {
    if (!snapshot) return;
    const attempt = latestAttemptForNode(snapshot, nodeKey);
    observation.selectNode(nodeKey);
    updateSelection({ attempt: attempt?.attemptId ?? null });
    setSurface("observation");
  };
  const selectAttempt = (attempt: WikiRunAttempt) => {
    observation.selectAttempt(attempt);
    updateSelection({ attempt: attempt.attemptId });
    setSurface("observation");
  };

  if (activity.loading) return <LoadingState />;

  const pendingDeleteSession = activity.sessions.find(
    (session) => session.id === pendingDeleteSessionId,
  );
  return (
    <WorkbenchShell
      workspaceId={id}
      workspaceName={activity.workspace?.name}
      mode="operate"
      immersive
      error={activity.error ?? observation.error}
      onDismissError={() => {
        activity.setError(null);
        observation.setError(null);
      }}
      actions={
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setLocale(locale === "en" ? "zh" : "en")}
            aria-label={t.locale.switchTo}
            title={`${t.locale.label}: ${locale === "en" ? t.locale.en : t.locale.zh}`}
            data-testid="locale-switch"
          >
            <LanguagesIcon data-icon="inline-start" />
            <span className="tabular-nums">{locale === "en" ? "EN" : "中"}</span>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void activity.refresh().catch(notifyError)}
            aria-label={t.workbench.refresh}
            title={t.workbench.refresh}
          >
            <RefreshCwIcon />
          </Button>
        </>
      }
    >
      <main className="flex min-h-0 flex-1 bg-background" data-testid="workspace-agent-page">
        <WorkbenchActivitySidebar
          sessions={activity.sessions}
          activeSessionId={activeSessionId}
          runs={activity.runs}
          activeRunId={activeRunId}
          onSelectSession={selectSession}
          onSelectRun={selectRun}
          onCreateSession={() => void createSession()}
          onDeleteSession={setPendingDeleteSessionId}
          creating={activity.creating}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          mobileOpen={sidebarOpen}
          onMobileOpenChange={setSidebarOpen}
          onShowConversation={() => {
            setSidebarCollapsed(false);
            setSurface("conversation");
          }}
          onShowRun={() => {
            setSidebarCollapsed(false);
            setSurface("run");
          }}
          t={t}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border py-2 pr-4 pl-12 md:px-6">
            <Tabs
              value={surface === "conversation" ? "conversation" : "run"}
              onValueChange={(value) => setSurface(value as Surface)}
            >
              <TabsList variant="line">
                <TabsTrigger value="conversation">{t.workbench.conversation}</TabsTrigger>
                <TabsTrigger value="run" disabled={!snapshot}>
                  {t.workbench.activeRun}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Badge variant={activeConnection === "live" ? "secondary" : "outline"}>
              {t.workbench.connectionStates[activeConnection]}
            </Badge>
          </div>
          {surface === "conversation" ? (
            <ConversationPanel
              conversation={conversation}
              runs={activeSessionRuns}
              onOpenRun={selectRun}
              onPromptSubmitted={(text) => {
                if (activeSessionId)
                  activity.updateTitleFromPrompt(activeSessionId, promptTitle(text));
              }}
              t={t}
              workspaceId={id}
              defaultProfileId={workspaceDefaultProfileId}
            />
          ) : snapshot && surface === "run" ? (
            <RunCanvas
              workspaceId={id}
              snapshot={snapshot}
              selectedNodeKey={selectedNodeKey}
              focusedStage={graphStage}
              onFocusedStageChange={(stage) => updateSelection({ stage })}
              t={t}
              planReviewState={planReviewState}
              onSelectNode={selectNode}
              onRunCommand={(command) => void dispatchRun(command)}
            />
          ) : snapshot ? (
            <AttemptObservation
              snapshot={snapshot}
              selectedNode={selectedNode}
              selectedAttempt={selectedAttempt}
              trace={timeline?.events ?? []}
              spec={spec}
              planReview={planReview}
              planReviewStatus={planReviewStatus}
              planReviewRetry={planReviewRetry}
              onBack={() => {
                updateSelection({ attempt: null });
                setSurface("run");
              }}
              onSelectAttempt={selectAttempt}
              onLoadEarlier={() => void observation.loadEarlier()}
              canLoadEarlier={Boolean(timeline?.hasEarlier)}
              loadingEarlier={Boolean(timeline?.loadingEarlier)}
              followMode={observation.followMode}
              onFollowModeChange={observation.setFollowMode}
              onRunCommand={(command) => void dispatchRun(command)}
              t={t}
            />
          ) : null}
        </div>
        <AlertDialog
          open={Boolean(pendingDeleteSession)}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteSessionId(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t.workbench.deleteSessionTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {formatMessage(t.workbench.deleteSessionDescription, {
                  title: pendingDeleteSession?.title || t.workbench.untitledSession,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (pendingDeleteSessionId) void deleteSession(pendingDeleteSessionId);
                  setPendingDeleteSessionId(null);
                }}
              >
                {t.common.delete}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    </WorkbenchShell>
  );
}
