import type { RunCommand, WikiRunSnapshot } from "@okf-wiki/contract";
import { PauseIcon, PlayIcon, SendIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { describeRunStatus, GateActionShell, StatusBadge } from "@/components/agent-ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatMessage, type MessageTree } from "../i18n";
import { newCommandId } from "../lib/command-id";
import {
  lastFailedAttemptForNode,
  listRecoveryTargetNodes,
  needsRecoveryBanner,
  shouldShowNoAutoRetryHint,
  truncateAttemptError,
} from "../run-workspace/node-recovery";
import { RunGraph } from "../run-workspace/RunGraph";
import type { WorkflowStageId } from "../run-workspace/workflow-topology";
import { localizedLabel } from "./workbench-utils";

function openGate(snapshot: WikiRunSnapshot) {
  return snapshot.gates.find((gate) => gate.state === "open");
}

type RunCanvasProps = {
  snapshot: WikiRunSnapshot;
  selectedNodeKey: string | null;
  focusedStage: WorkflowStageId | null;
  onFocusedStageChange: (stage: WorkflowStageId | null) => void;
  onSelectNode: (nodeKey: string) => void;
  onRunCommand: (command: (snapshot: WikiRunSnapshot) => RunCommand) => void;
  t: MessageTree;
};

export function RunCanvas({
  snapshot,
  selectedNodeKey,
  focusedStage,
  onFocusedStageChange,
  onSelectNode,
  onRunCommand,
  t,
}: RunCanvasProps) {
  const gate = openGate(snapshot);
  const [feedback, setFeedback] = useState("");
  const [answer, setAnswer] = useState("");
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const activeNode =
    snapshot.nodes.find((node) => node.state === "running") ??
    snapshot.nodes.find((node) => node.state === "ready");
  const recoveryTargets = listRecoveryTargetNodes(snapshot);
  const showRecovery = needsRecoveryBanner(snapshot);
  const primaryRecovery = recoveryTargets[0] ?? null;
  const primaryFailedAttempt = primaryRecovery
    ? lastFailedAttemptForNode(snapshot, primaryRecovery.key)
    : null;
  const primaryErrorPreview =
    primaryFailedAttempt?.error != null && primaryFailedAttempt.error.length > 0
      ? truncateAttemptError(primaryFailedAttempt.error)
      : null;
  const showNoAutoRetryHint = Boolean(
    primaryRecovery &&
      shouldShowNoAutoRetryHint(primaryFailedAttempt?.failureClass, primaryRecovery.kind),
  );

  const resolve = (decision: "approve" | "deny" | "revise" | "pass" | "fix" | "answer") => {
    if (!gate) return;
    onRunCommand(
      (latest) =>
        ({
          type: "resolve_gate",
          commandId: newCommandId(),
          runId: latest.runId,
          expectedRevision: latest.revision,
          gateId: gate.gateId,
          gateKind: gate.kind,
          payloadDigest: gate.payloadDigest,
          decision,
          ...(decision === "answer" ? { answer: answer.trim() } : {}),
          ...(["revise", "fix"].includes(decision) && feedback.trim()
            ? { feedback: feedback.trim() }
            : {}),
        }) as RunCommand,
    );
  };

  const cancelRun = () => {
    onRunCommand((current) => ({
      type: "cancel_run",
      commandId: newCommandId(),
      runId: current.runId,
      expectedRevision: current.revision,
    }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="run-canvas">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">
              {activeNode?.label ?? t.runInspector.title}
            </h2>
            <StatusBadge descriptor={describeRunStatus(snapshot.state)}>
              {localizedLabel(t.workbench.runStates, snapshot.state)}
            </StatusBadge>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{snapshot.runId}</p>
        </div>
        <div className="flex items-center gap-1">
          {snapshot.state === "paused" ? (
            <Button
              size="sm"
              onClick={() =>
                onRunCommand((current) => ({
                  type: "resume_run",
                  commandId: newCommandId(),
                  runId: current.runId,
                  expectedRevision: current.revision,
                }))
              }
            >
              <PlayIcon data-icon="inline-start" />
              {t.workbench.resumeRun}
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() =>
                onRunCommand((current) => ({
                  type: "pause_run",
                  commandId: newCommandId(),
                  runId: current.runId,
                  expectedRevision: current.revision,
                }))
              }
              disabled={["published", "failed", "cancelled"].includes(snapshot.state)}
              aria-label={t.workbench.pauseRun}
              title={t.workbench.pauseRunHint}
            >
              <PauseIcon />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="destructive"
            onClick={() => setConfirmCancelOpen(true)}
            disabled={["published", "failed", "cancelled"].includes(snapshot.state)}
            aria-label={t.workbench.cancelRun}
            title={t.workbench.cancelRun}
          >
            <SquareIcon />
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmCancelOpen}
        onOpenChange={setConfirmCancelOpen}
        title={t.workbench.cancelRun}
        description={t.workbench.cancelRunConfirm}
        confirmLabel={t.workbench.cancelRun}
        onConfirm={cancelRun}
        destructive
        data-testid="cancel-run-dialog"
        confirmTestId="cancel-run-confirm"
      />
      <div className="flex min-h-0 flex-1 flex-col px-4 py-5 md:px-6">
        {showRecovery ? (
          <Alert className="mb-5" data-testid="recovery-banner">
            <TriangleAlertIcon />
            <AlertTitle>{t.workbench.recoveryBannerTitle}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>
                {primaryRecovery
                  ? primaryErrorPreview
                    ? formatMessage(t.workbench.recoveryBannerWithReason, {
                        node: primaryRecovery.label || primaryRecovery.key,
                        count: recoveryTargets.length,
                        reason: primaryErrorPreview,
                      })
                    : formatMessage(t.workbench.recoveryBanner, {
                        node: primaryRecovery.label || primaryRecovery.key,
                        count: recoveryTargets.length,
                      })
                  : t.workbench.recoveryBannerGeneric}
              </span>
              {primaryRecovery ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 self-start"
                  data-testid="recovery-open-node"
                  onClick={() => onSelectNode(primaryRecovery.key)}
                >
                  {formatMessage(t.workbench.recoveryOpenNode, {
                    node: primaryRecovery.label || primaryRecovery.key,
                  })}
                </Button>
              ) : null}
            </AlertDescription>
            {showNoAutoRetryHint ? (
              <p
                className="col-start-2 mt-1 text-xs text-muted-foreground"
                data-testid="recovery-no-auto-retry-hint"
              >
                {t.workbench.noAutoRetryHint}
              </p>
            ) : null}
            {recoveryTargets.length > 1 ? (
              <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                {recoveryTargets.map((node) => (
                  <li key={node.key}>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-auto px-2 py-1 font-mono"
                      onClick={() => onSelectNode(node.key)}
                    >
                      {node.label || node.key}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
        {gate ? (
          <GateActionShell
            className="mb-5"
            title={formatMessage(t.workbench.decisionTitle, {
              kind: localizedLabel(t.workbench.gateKinds, gate.kind),
            })}
            detail={gate.detail?.summary ?? t.workbench.decisionFallback}
            technicalDetailsLabel={t.workbench.technicalDetails}
            meta={<p className="font-mono text-xs text-muted-foreground">{gate.gateId}</p>}
            actions={
              <>
                {gate.kind === "operator_input" ? (
                  <Button size="sm" onClick={() => resolve("answer")} disabled={!answer.trim()}>
                    <SendIcon data-icon="inline-start" />
                    {t.workbench.sendAnswer}
                  </Button>
                ) : null}
                {gate.kind === "fix" ? (
                  <>
                    <Button size="sm" onClick={() => resolve("pass")}>
                      {t.workbench.acceptCandidate}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => resolve("fix")}>
                      {t.workbench.repairAutomatically}
                    </Button>
                  </>
                ) : null}
                {["plan", "publication"].includes(gate.kind) ? (
                  <>
                    <Button size="sm" onClick={() => resolve("approve")}>
                      {t.workbench.approve}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolve("revise")}
                      disabled={!feedback.trim()}
                    >
                      {t.workbench.revise}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => resolve("deny")}>
                      {t.workbench.decline}
                    </Button>
                  </>
                ) : null}
              </>
            }
          >
            {gate.kind === "operator_input" ? (
              <Textarea
                className="min-h-20"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder={t.workbench.answerPlaceholder}
                aria-label={t.workbench.answerPlaceholder}
              />
            ) : (
              <Textarea
                className="min-h-20"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.workbench.guidancePlaceholder}
                aria-label={t.workbench.guidancePlaceholder}
              />
            )}
          </GateActionShell>
        ) : null}
        <RunGraph
          snapshot={snapshot}
          selectedNodeKey={selectedNodeKey}
          focusedStage={focusedStage}
          onFocusedStageChange={onFocusedStageChange}
          onSelectNode={onSelectNode}
          t={t}
        />
      </div>
    </div>
  );
}
