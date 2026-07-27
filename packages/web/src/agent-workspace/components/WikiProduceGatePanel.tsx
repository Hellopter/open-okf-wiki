/**
 * wiki_produce panel — status + page chips + layered run-graph chips.
 * Node run detail opens in a Dialog (never stacked under the graph in-chat).
 */

import type {
  AgentResumeGateCommand,
  NodeAttempt,
  WikiProduceToolDetails,
} from "@okf-wiki/contract";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "../../i18n";
import { compactSummary } from "../run-graph/compact-summary";
import { NodeAttemptDialog } from "../run-graph/NodeAttemptDialog";
import { RunGraphCanvas } from "../run-graph/RunGraphCanvas";
import { RunInspectorDialog } from "../run-graph/RunInspectorDialog";
import { SpecReviewView } from "./SpecReviewView";
import { StatusBadge } from "./StatusBadge";

export type WikiProduceGatePanelProps = {
  details: WikiProduceToolDetails;
  onResumeGate: (command: AgentResumeGateCommand) => Promise<void>;
};

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}…` : runId;
}

function attemptsForNode(attempts: NodeAttempt[], nodeKey: string): NodeAttempt[] {
  return attempts.filter((a) => a.nodeKey === nodeKey).sort((a, b) => a.runIndex - b.runIndex);
}

function latestAttemptForNode(attempts: NodeAttempt[], nodeKey: string): NodeAttempt | undefined {
  const forNode = attemptsForNode(attempts, nodeKey);
  if (forNode.length === 0) return undefined;
  return forNode[forNode.length - 1];
}

export function WikiProduceGatePanel({ details, onResumeGate }: WikiProduceGatePanelProps) {
  const { t } = useI18n();
  // Route-scoped workspace ref for the post-run inspector (durable server state).
  const { id: routeWorkspaceId = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const gate =
    details.status === "awaiting_plan"
      ? ("plan" as const)
      : details.status === "awaiting_publication"
        ? ("publication" as const)
        : null;
  const pages = details.spec?.pages.map((page) => page.path) ?? details.pages ?? [];
  const graphAttempts = details.graph?.attempts;
  const attempts = useMemo(() => graphAttempts ?? [], [graphAttempts]);
  const [submitting, setSubmitting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [dialogNodeKey, setDialogNodeKey] = useState<string | null>(null);
  const [dialogAttemptId, setDialogAttemptId] = useState<string | null>(null);

  useEffect(() => {
    setSubmitting(false);
    setRevising(false);
    setFeedback("");
    setDialogNodeKey(null);
    setDialogAttemptId(null);
  }, [details.runId, details.status]);

  const relatedAttempts = useMemo(() => {
    if (!dialogNodeKey) return [] as NodeAttempt[];
    return attemptsForNode(attempts, dialogNodeKey);
  }, [attempts, dialogNodeKey]);

  const dialogAttempt = useMemo(() => {
    if (!dialogNodeKey) return undefined;
    if (dialogAttemptId) {
      return relatedAttempts.find((a) => a.attemptId === dialogAttemptId) ?? relatedAttempts.at(-1);
    }
    return relatedAttempts.at(-1) ?? latestAttemptForNode(attempts, dialogNodeKey);
  }, [attempts, dialogAttemptId, dialogNodeKey, relatedAttempts]);

  const dialogLabel = useMemo(() => {
    if (!dialogNodeKey) return "";
    const fromTopo = details.graph?.topology.find((n) => n.nodeKey === dialogNodeKey)?.label;
    return fromTopo ?? dialogAttempt?.role ?? dialogNodeKey;
  }, [details.graph?.topology, dialogAttempt?.role, dialogNodeKey]);

  const openNode = (nodeKey: string) => {
    const latest = latestAttemptForNode(attempts, nodeKey);
    setDialogNodeKey(nodeKey);
    setDialogAttemptId(latest?.attemptId ?? null);
  };

  const decide = async (action: "approve" | "deny" | "revise") => {
    if (!gate || !details.runId || submitting) return;
    if (action === "revise" && !feedback.trim()) {
      setRevising(true);
      return;
    }
    setSubmitting(true);
    try {
      await onResumeGate({
        type: "resume_gate",
        gate,
        action,
        runId: details.runId,
        ...(gate === "plan" && details.spec ? { spec: details.spec } : {}),
        ...(action === "revise" ? { feedback: feedback.trim() } : {}),
      });
    } catch {
      setSubmitting(false);
    }
  };

  const title =
    gate === "plan"
      ? t.planConfirm.title
      : gate === "publication"
        ? t.runStatus.awaiting_publication
        : details.status;

  const oneLineSummary =
    compactSummary(details.summary, 96) || compactSummary(details.spec?.summary, 96);

  const hasGraph =
    Boolean(details.graph) &&
    ((details.graph?.topology.length ?? 0) > 0 || (details.graph?.attempts.length ?? 0) > 0);

  const orphanNodeKeys = useMemo(() => {
    if (hasGraph && (details.graph?.topology.length ?? 0) > 0) return [] as string[];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const a of attempts) {
      if (seen.has(a.nodeKey)) continue;
      seen.add(a.nodeKey);
      keys.push(a.nodeKey);
    }
    return keys;
  }, [attempts, details.graph?.topology.length, hasGraph]);

  return (
    <div
      className="flex flex-col gap-2.5 rounded-md border border-border/70 bg-muted/15 p-2.5"
      data-testid="wiki-produce-details"
      data-wiki-status={details.status}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant={gate ? "default" : "secondary"}>{title}</Badge>
          {oneLineSummary ? (
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={details.summary ?? details.spec?.summary}
            >
              {oneLineSummary}
            </span>
          ) : null}
        </div>
        {details.runId ? (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground" title={details.runId}>
            {shortRunId(details.runId)}
          </span>
        ) : null}
      </div>

      {gate === "plan" && details.spec ? (
        <div className="border-t border-border/60 pt-2">
          <SpecReviewView spec={details.spec} />
        </div>
      ) : pages.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="okf-section-label">
            {t.planConfirm.pagesLabel} · {pages.length}
          </p>
          <ul className="flex flex-wrap gap-1">
            {pages.map((page) => (
              <li key={page}>
                <Badge variant="outline" className="max-w-[12rem] font-mono text-2xs font-normal">
                  <span className="truncate">{page}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasGraph && details.graph ? (
        <div
          className="flex flex-col gap-1.5 border-t border-border/60 pt-2"
          data-testid="wiki-produce-graph"
        >
          <p className="okf-section-label">
            {t.agentWorkspace.runGraph}
            {attempts.length > 0 ? ` · ${attempts.length}` : null}
          </p>
          <RunGraphCanvas
            graph={details.graph}
            selectedNodeKey={dialogNodeKey}
            onSelectNode={openNode}
          />
        </div>
      ) : orphanNodeKeys.length > 0 ? (
        <div
          className="flex flex-col gap-1.5 border-t border-border/60 pt-2"
          data-testid="wiki-produce-graph"
        >
          <p className="okf-section-label">
            {t.agentWorkspace.runGraph} · {orphanNodeKeys.length}
          </p>
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {orphanNodeKeys.map((nodeKey) => {
              const latest = latestAttemptForNode(attempts, nodeKey);
              return (
                <li key={nodeKey}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-left text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    data-testid="run-graph-node"
                    data-node-key={nodeKey}
                    data-node-status={latest?.status ?? "idle"}
                    onClick={() => openNode(nodeKey)}
                  >
                    <span className="truncate font-medium">{latest?.role ?? nodeKey}</span>
                    <StatusBadge status={latest?.status ?? "idle"} className="shrink-0" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {!gate && details.runId && routeWorkspaceId ? (
        <div className="border-t border-border/60 pt-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="wiki-produce-view-run"
            onClick={() => setInspectorOpen(true)}
          >
            {t.runInspector.viewRun}
          </Button>
          <RunInspectorDialog
            workspaceId={routeWorkspaceId}
            rootPath={rootPathHint}
            runId={details.runId}
            open={inspectorOpen}
            onOpenChange={setInspectorOpen}
          />
        </div>
      ) : null}

      <NodeAttemptDialog
        open={dialogNodeKey != null}
        onOpenChange={(open) => {
          if (!open) {
            setDialogNodeKey(null);
            setDialogAttemptId(null);
          }
        }}
        nodeKey={dialogNodeKey ?? ""}
        nodeLabel={dialogLabel}
        attempt={dialogAttempt}
        relatedAttempts={relatedAttempts}
        onSelectAttempt={setDialogAttemptId}
      />

      {gate && details.runId ? (
        <div
          className="flex flex-col gap-2 border-t border-border/60 pt-2"
          data-testid={`agent-${gate}-gate`}
        >
          {revising && gate === "plan" ? (
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="agent-gate-feedback" className="text-xs">
                {t.planConfirm.reviseLabel}
              </FieldLabel>
              <Textarea
                id="agent-gate-feedback"
                data-testid="agent-gate-feedback"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.planConfirm.revisePlaceholder}
                disabled={submitting}
                rows={2}
                className="min-h-16 text-xs"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              data-testid="agent-gate-approve"
              disabled={submitting || revising}
              onClick={() => void decide("approve")}
            >
              {submitting
                ? t.planConfirm.working
                : gate === "plan"
                  ? t.planConfirm.approve
                  : t.planConfirm.chipPublish}
            </Button>
            {gate === "plan" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={revising ? "agent-gate-revise-submit" : "agent-gate-revise"}
                disabled={submitting || (revising && !feedback.trim())}
                onClick={() => {
                  if (!revising) setRevising(true);
                  else void decide("revise");
                }}
              >
                {revising ? t.planConfirm.reviseSubmit : t.planConfirm.revise}
              </Button>
            ) : null}
            {revising ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="agent-gate-revise-cancel"
                disabled={submitting}
                onClick={() => {
                  setRevising(false);
                  setFeedback("");
                }}
              >
                {t.common.cancel}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="agent-gate-deny"
                disabled={submitting}
                onClick={() => void decide("deny")}
              >
                {gate === "plan" ? t.planConfirm.decline : t.planConfirm.chipKeepStaging}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
