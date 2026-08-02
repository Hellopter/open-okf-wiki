import type { RunCommand, WikiRunSnapshot } from "@okf-wiki/contract";
import { FileTextIcon, PauseIcon, PlayIcon, SendIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatMessage, type MessageTree } from "../i18n";
import { newCommandId } from "../lib/command-id";
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
  const activeNode =
    snapshot.nodes.find((node) => node.state === "running") ??
    snapshot.nodes.find((node) => node.state === "ready");
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="run-canvas">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">
              {activeNode?.label ?? t.runInspector.title}
            </h2>
            <Badge variant={snapshot.state === "failed" ? "destructive" : "secondary"}>
              {localizedLabel(t.workbench.runStates, snapshot.state)}
            </Badge>
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
              title={t.workbench.pauseRun}
            >
              <PauseIcon />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="destructive"
            onClick={() =>
              onRunCommand((current) => ({
                type: "cancel_run",
                commandId: newCommandId(),
                runId: current.runId,
                expectedRevision: current.revision,
              }))
            }
            disabled={["published", "failed", "cancelled"].includes(snapshot.state)}
            aria-label={t.workbench.cancelRun}
            title={t.workbench.cancelRun}
          >
            <SquareIcon />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-4 py-5 md:px-6">
        {gate ? (
          <Alert className="mb-5">
            <FileTextIcon />
            <AlertTitle>
              {formatMessage(t.workbench.decisionTitle, {
                kind: localizedLabel(t.workbench.gateKinds, gate.kind),
              })}
            </AlertTitle>
            <AlertDescription>
              {gate.detail?.summary ?? t.workbench.decisionFallback}
            </AlertDescription>
            {gate.kind === "operator_input" ? (
              <Textarea
                className="mt-3 min-h-20"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder={t.workbench.answerPlaceholder}
              />
            ) : (
              <Textarea
                className="mt-3 min-h-20"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.workbench.guidancePlaceholder}
              />
            )}
            <div className="mt-3 flex flex-wrap gap-2">
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
            </div>
          </Alert>
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
