import type { RunCommand, WikiRunAttempt, WikiRunSnapshot } from "@okf-wiki/contract/wiki-runs";
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

/**
 * Workbench panel derived solely from URL selection (ADR 0039 / Epic F).
 * `?attempt` or `?node` → observation · `?run` → run canvas · else conversation.
 * No independent React surface store.
 */
type Surface = "conversation" | "run" | "observation";

function surfaceFromSelection(
  runId: string | null,
  attemptId: string | null,
  nodeKey: string | null,
): Surface {
  if (attemptId || nodeKey) return "observation";
  if (runId) return "run";
  return "conversation";
}

export function WorkspaceAgentPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("okf-wiki:workbench-timeline-collapsed") === "true",
  );
  const { t, locale, setLocale } = useI18n();
  const activeSessionId = params.get("session");
  const activeRunId = params.get("run");
  const activeAttemptId = params.get("attempt");
  const activeNodeKey = params.get("node");
  const stageParam = params.get("stage");
  const graphStage =
    stageParam && workflowStageIds.includes(stageParam as WorkflowStageId)
      ? (stageParam as WorkflowStageId)
      : null;
  const surface = surfaceFromSelection(activeRunId, activeAttemptId, activeNodeKey);

  const updateSelection = useCallback(
    (next: {
      session?: string | null;
      run?: string | null;
      attempt?: string | null;
      node?: string | null;
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
  const observation = useRunObservation(id, activeRunId, activeAttemptId, activeNodeKey);
  const {
    snapshot,
    spec,
    planReview,
    planReviewStatus,
    planReviewRetry,
    selectedAttempt,
    selectedNode,
    selectedNodeKey,
    planScoutDisplays,
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
  const activeSessionRuns = sessionRunLinks(activity.runs, activeSessionId);

  useEffect(() => {
    window.localStorage.setItem("okf-wiki:workbench-timeline-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const createSession = async () => {
    const created = await activity.createSession();
    if (!created) return;
    updateSelection({ session: created.id, run: null, attempt: null, node: null });
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
    // Session focus clears Run selection so URL surface becomes conversation.
    updateSelection({
      session: sessionId,
      run: null,
      attempt: null,
      node: null,
      stage: null,
    });
    setSidebarOpen(false);
  };
  const selectRun = (runId: string) => {
    updateSelection({ run: runId, attempt: null, node: null, stage: null });
    setSidebarOpen(false);
  };
  const deleteSession = async (sessionId: string) => {
    const nextSessions = await activity.removeSession(sessionId);
    if (!nextSessions || sessionId !== activeSessionId) return;
    updateSelection({ session: nextSessions[0]?.id ?? null });
  };
  const selectNode = (nodeKey: string) => {
    if (!snapshot) return;
    // Durable plan.scout.* uses real attempts (transcript SSE) like leaf/domain.
    // Legacy display-only scouts have no attempts — pin the node key instead.
    const attempt = latestAttemptForNode(snapshot, nodeKey);
    observation.selectNode(nodeKey);
    if (attempt) {
      updateSelection({ attempt: attempt.attemptId, node: null });
    } else {
      updateSelection({ attempt: null, node: nodeKey });
    }
  };
  const selectAttempt = (attempt: WikiRunAttempt) => {
    observation.selectAttempt(attempt);
    updateSelection({ attempt: attempt.attemptId, node: null });
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
            updateSelection({ run: null, attempt: null, node: null, stage: null });
          }}
          onShowRun={() => {
            setSidebarCollapsed(false);
            // URL already selects run; clear observation pins to show run canvas.
            if (activeRunId) updateSelection({ attempt: null, node: null });
          }}
          t={t}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border py-2 pr-4 pl-12 md:px-6">
            <Tabs
              value={surface === "conversation" ? "conversation" : "run"}
              onValueChange={(value) => {
                if (value === "conversation") {
                  updateSelection({ run: null, attempt: null, node: null, stage: null });
                } else if (activeRunId) {
                  updateSelection({ attempt: null, node: null });
                }
              }}
            >
              <TabsList variant="line">
                <TabsTrigger value="conversation">{t.workbench.conversation}</TabsTrigger>
                <TabsTrigger value="run" disabled={!activeRunId}>
                  {t.workbench.activeRun}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {/* Separate Session vs Run SSE indicators (ADR 0039 — never merge domains). */}
            <div className="flex items-center gap-2" data-testid="connection-indicators">
              <Badge
                variant={conversation.connection === "live" ? "secondary" : "outline"}
                data-testid="session-connection"
                title={t.workbench.conversation}
              >
                {t.workbench.conversation}:{" "}
                {t.workbench.connectionStates[conversation.connection]}
              </Badge>
              {activeRunId ? (
                <Badge
                  variant={observation.connection === "live" ? "secondary" : "outline"}
                  data-testid="run-connection"
                  title={t.workbench.activeRun}
                >
                  {t.workbench.activeRun}:{" "}
                  {t.workbench.connectionStates[observation.connection]}
                </Badge>
              ) : null}
            </div>
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
              planScoutDisplays={planScoutDisplays}
              onBack={() => {
                updateSelection({ attempt: null, node: null });
              }}
              onSelectAttempt={selectAttempt}
              onSelectNode={selectNode}
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
