import type { RunCommand, WikiRunSnapshot, WorkspaceConfig } from "@okf-wiki/contract";
import { Activity, FileSearch, Pause, Play, Square, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  dispatchWikiRunCommand,
  getWikiRun,
  getWikiRunSpec,
  getWorkspace,
  hasApiErrorCode,
  parseWikiRunEvent,
  parseWikiRunSnapshotEvent,
  wikiRunEventsUrl,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { newCommandId } from "../lib/command-id";
import { WorkbenchShell } from "../shells/WorkbenchShell";

function currentGate(snapshot: WikiRunSnapshot): WikiRunSnapshot["gates"][number] | undefined {
  return snapshot.gates.find((gate) => gate.state === "open");
}

function titleFor(snapshot: WikiRunSnapshot): string {
  const gate = currentGate(snapshot);
  if (gate?.kind === "publication" && gate.detail?.summary?.startsWith("Publication conflict")) {
    return "Publication conflict";
  }
  if (gate?.kind === "plan") return "Plan review";
  if (gate?.kind === "publication") return "Publication review";
  if (gate?.kind === "fix") return "Repair decision";
  if (gate?.kind === "operator_input") return "Operator input";
  if (snapshot.candidates.length > 0) return "Candidate review";
  const active =
    snapshot.nodes.find((node) => node.state === "running") ??
    snapshot.nodes.find((node) => node.state === "ready");
  return active?.label ?? "Run activity";
}

export function RunDetailPage() {
  const { id = "", runId = "" } = useParams<{ id: string; runId: string }>();
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [snapshot, setSnapshot] = useState<WikiRunSnapshot | null>(null);
  const [scopeChange, setScopeChange] = useState("");
  const [feedback, setFeedback] = useState("");
  const [operatorAnswer, setOperatorAnswer] = useState("");
  const [specSummary, setSpecSummary] = useState<string | null>(null);
  const [connection, setConnection] = useState<"live" | "reconnecting" | "offline">("offline");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!id || !runId) return;
    const [workspaceResult, run] = await Promise.all([getWorkspace(id), getWikiRun(id, runId)]);
    setWorkspace(workspaceResult.workspace);
    setSnapshot(run.snapshot);
  }, [id, runId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh()
      .catch((nextError) => {
        if (!cancelled) setError(nextError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!id || !runId) return;
    const source = new EventSource(wikiRunEventsUrl(id, runId));
    const applySnapshot = (event: MessageEvent<string>) => {
      try {
        setSnapshot(parseWikiRunSnapshotEvent(event.data));
        setConnection("live");
      } catch {
        setConnection("reconnecting");
      }
    };
    const applyEvent = (event: MessageEvent<string>) => {
      try {
        setSnapshot(parseWikiRunEvent(event.data).snapshot);
        setConnection("live");
      } catch {
        setConnection("reconnecting");
      }
    };
    source.addEventListener("snapshot", applySnapshot as EventListener);
    source.addEventListener("run.event", applyEvent as EventListener);
    source.onerror = () => setConnection("reconnecting");
    return () => source.close();
  }, [id, runId]);

  const gate = snapshot ? currentGate(snapshot) : undefined;
  const publicationConflict =
    gate?.kind === "publication" && gate.detail?.summary?.startsWith("Publication conflict");
  const controlsPaused = snapshot?.state === "paused" || snapshot?.state === "pausing";
  useEffect(() => {
    if (!gate || gate.kind !== "plan" || !id || !runId) {
      setSpecSummary(null);
      return;
    }
    void getWikiRunSpec(id, runId)
      .then((result) => setSpecSummary(result.spec.summary))
      .catch(() => setSpecSummary(null));
  }, [gate, id, runId]);

  const dispatch = async (build: (latest: WikiRunSnapshot) => RunCommand) => {
    if (!id || !runId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let latest = (await getWikiRun(id, runId)).snapshot;
      setSnapshot(latest);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await dispatchWikiRunCommand(id, build(latest));
          break;
        } catch (nextError) {
          if (attempt === 0 && hasApiErrorCode(nextError, "stale_revision")) {
            latest = (await getWikiRun(id, runId)).snapshot;
            setSnapshot(latest);
            continue;
          }
          throw nextError;
        }
      }
      toast.success("Command accepted");
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSubmitting(false);
    }
  };

  const resolveGate = (decision: "approve" | "deny" | "revise" | "pass" | "fix" | "answer") => {
    if (!snapshot || !gate) return;
    const gateId = gate.gateId;
    void dispatch((latest) => {
      const current = latest.gates.find((item) => item.gateId === gateId);
      if (!current)
        throw new Error("This gate has already changed. Refresh the Run before deciding.");
      return {
        type: "resolve_gate",
        commandId: newCommandId(),
        runId: latest.runId,
        expectedRevision: latest.revision,
        gateId: current.gateId,
        gateKind: current.kind,
        payloadDigest: current.payloadDigest,
        decision,
        ...(decision === "answer" ? { answer: operatorAnswer.trim() } : {}),
        ...(decision === "revise" || decision === "fix"
          ? feedback.trim()
            ? { feedback: feedback.trim() }
            : {}
          : {}),
      } as RunCommand;
    });
  };

  const submitScopeChange = (content: string) => {
    if (!snapshot || !content.trim()) return;
    const revisionContent = content.trim();
    void dispatch((latest) => ({
      type: "submit_run_revision",
      commandId: newCommandId(),
      runId: latest.runId,
      expectedRevision: latest.revision,
      kind: "scope_change",
      content: revisionContent,
    }));
    setScopeChange("");
  };

  const stage = useMemo(() => (snapshot ? titleFor(snapshot) : "Run"), [snapshot]);
  if (loading || !snapshot) return <LoadingState />;

  return (
    <WorkbenchShell workspaceId={id} workspaceName={workspace?.name} mode="operate" immersive>
      <main
        className="flex min-h-0 flex-1 flex-col bg-background"
        data-testid="run-workspace-detail"
      >
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 lg:px-6">
          <div className="min-w-0">
            <Link
              to={`/w/${encodeURIComponent(id)}/runs`}
              className="text-xs text-muted-foreground no-underline hover:underline"
            >
              Runs
            </Link>
            <h2 className="mt-1 truncate text-base font-semibold">{stage}</h2>
            <div className="mt-1 flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <span>{snapshot.runId}</span>
              <span className={connection === "live" ? "text-emerald-600" : "text-amber-700"}>
                {connection}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {snapshot.state === "paused" ? (
              <Button
                size="sm"
                onClick={() =>
                  void dispatch((latest) => ({
                    type: "resume_run",
                    commandId: newCommandId(),
                    runId: latest.runId,
                    expectedRevision: latest.revision,
                  }))
                }
                disabled={submitting}
              >
                <Play />
                Resume
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant="outline"
                onClick={() =>
                  void dispatch((latest) => ({
                    type: "pause_run",
                    commandId: newCommandId(),
                    runId: latest.runId,
                    expectedRevision: latest.revision,
                  }))
                }
                disabled={
                  submitting || ["published", "cancelled", "failed"].includes(snapshot.state)
                }
                title="Pause Run"
                aria-label="Pause Run"
              >
                <Pause />
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="destructive"
              onClick={() =>
                void dispatch((latest) => ({
                  type: "cancel_run",
                  commandId: newCommandId(),
                  runId: latest.runId,
                  expectedRevision: latest.revision,
                }))
              }
              disabled={submitting || ["published", "cancelled", "failed"].includes(snapshot.state)}
              title="Cancel Run"
              aria-label="Cancel Run"
            >
              <Square />
            </Button>
          </div>
        </header>

        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

        <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="min-h-0 overflow-y-auto px-4 py-5 lg:px-6">
            {gate ? (
              <div className="max-w-3xl">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <TriangleAlert className="size-4 text-amber-600" />
                  {stage}
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                  {gate.detail?.summary ??
                    specSummary ??
                    "This Run is waiting for an explicit operator decision."}
                </p>
                {gate.kind === "plan" || gate.kind === "publication" || gate.kind === "fix" ? (
                  <Textarea
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                    className="mt-5 min-h-24 max-w-2xl"
                    placeholder="Decision notes"
                  />
                ) : null}
                {gate.kind === "operator_input" ? (
                  <Textarea
                    value={operatorAnswer}
                    onChange={(event) => setOperatorAnswer(event.target.value)}
                    className="mt-5 min-h-24 max-w-2xl"
                    placeholder="Answer for this Run"
                  />
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  {gate.kind === "operator_input" ? (
                    <Button
                      onClick={() => resolveGate("answer")}
                      disabled={submitting || controlsPaused || !operatorAnswer.trim()}
                    >
                      Send answer
                    </Button>
                  ) : null}
                  {gate.kind === "fix" ? (
                    <>
                      <Button
                        onClick={() => resolveGate("pass")}
                        disabled={submitting || controlsPaused}
                      >
                        Pass
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => resolveGate("fix")}
                        disabled={submitting || controlsPaused}
                      >
                        Repair
                      </Button>
                    </>
                  ) : null}
                  {gate.kind !== "operator_input" && gate.kind !== "fix" ? (
                    <Button
                      onClick={() => resolveGate("approve")}
                      disabled={submitting || controlsPaused}
                    >
                      {publicationConflict ? "Refresh and rebase" : "Approve"}
                    </Button>
                  ) : null}
                  {gate.kind !== "operator_input" ? (
                    <Button
                      variant="outline"
                      onClick={() => resolveGate("revise")}
                      disabled={submitting || controlsPaused || !feedback.trim()}
                    >
                      {publicationConflict ? "Rebase with notes" : "Revise"}
                    </Button>
                  ) : null}
                  {gate.kind !== "operator_input" ? (
                    <Button
                      variant="destructive"
                      onClick={() => resolveGate("deny")}
                      disabled={submitting || controlsPaused}
                    >
                      {publicationConflict ? "Abandon candidate" : "Decline"}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : snapshot.candidates.length > 0 ? (
              <div className="max-w-3xl">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileSearch className="size-4" />
                  Candidate ready
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Review a sealed candidate, evidence map, and line diff before requesting repair or
                  publication.
                </p>
                <div className="mt-4 divide-y divide-border border-y border-border">
                  {[...snapshot.candidates].reverse().map((candidate) => (
                    <Link
                      key={candidate.candidateId}
                      to={`/w/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/review?candidate=${encodeURIComponent(candidate.digest)}&page=index.md`}
                      className="flex items-center justify-between gap-3 py-3 text-sm no-underline hover:text-primary"
                    >
                      <span className="font-mono text-xs">{candidate.digest.slice(0, 16)}</span>
                      <span>{candidate.producedBy}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex max-w-3xl items-center gap-3 text-sm text-muted-foreground">
                <Activity className="size-4" />
                The scheduler will advance this Run as sealed inputs and capacity become available.
              </div>
            )}
          </section>

          <aside className="min-h-0 overflow-y-auto border-t border-border px-4 py-5 xl:border-t-0 xl:border-l">
            <h3 className="text-sm font-medium">Run control</h3>
            <Textarea
              value={scopeChange}
              onChange={(event) => setScopeChange(event.target.value)}
              className="mt-3 min-h-20 resize-none"
              placeholder="Scope change"
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => submitScopeChange(scopeChange)}
              disabled={submitting || !scopeChange.trim()}
            >
              Replan scope
            </Button>

            <h3 className="mt-7 text-sm font-medium">Activity</h3>
            <ol className="mt-3 space-y-3 border-l border-border pl-3 text-xs">
              {snapshot.revisions
                .slice()
                .reverse()
                .map((revision) => (
                  <li key={revision.revisionId}>
                    <div className="text-foreground">{revision.kind.replaceAll("_", " ")}</div>
                    <div className="mt-0.5 text-muted-foreground">
                      {revision.appliedAt ? "Applied" : "Queued"}
                    </div>
                  </li>
                ))}
              {snapshot.attempts
                .slice()
                .reverse()
                .slice(0, 12)
                .map((attempt) => (
                  <li key={attempt.attemptId}>
                    <div className="text-foreground">{attempt.nodeKey}</div>
                    <div className="mt-0.5 text-muted-foreground">{attempt.state}</div>
                  </li>
                ))}
            </ol>
          </aside>
        </div>
      </main>
    </WorkbenchShell>
  );
}
