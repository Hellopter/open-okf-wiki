import type { WikiRunListItem, WorkspaceConfig } from "@okf-wiki/contract";
import { Play, Plus, Radio, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  describeConnectionStatus,
  describeRunStatus,
  statusToneTextClass,
} from "@/components/agent-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  dispatchWikiRunCommand,
  getRunIndex,
  getWorkspace,
  parseWikiRunIndexEvent,
  wikiRunIndexEventsUrl,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { useI18n } from "../i18n";
import { newCommandId } from "../lib/command-id";
import { notifyError } from "../lib/notify";
import { WorkbenchShell } from "../shells/WorkbenchShell";

function stateLabel(state: WikiRunListItem["state"]): string {
  return state.replaceAll("_", " ");
}

function stateColor(state: WikiRunListItem["state"]): string {
  return statusToneTextClass(describeRunStatus(state).tone);
}

export function RunWorkspacePage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [runs, setRuns] = useState<WikiRunListItem[]>([]);
  const [objective, setObjective] = useState("");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [connection, setConnection] = useState<"live" | "reconnecting" | "offline">("offline");
  const [loadError, setLoadError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    const [workspaceResult, index] = await Promise.all([getWorkspace(id), getRunIndex(id)]);
    setWorkspace(workspaceResult.workspace);
    setRuns(index.runs);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void refresh()
      .catch((nextError) => {
        if (!cancelled) setLoadError(nextError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!id) return;
    const source = new EventSource(wikiRunIndexEventsUrl(id));
    source.addEventListener("index", (event) => {
      try {
        const payload = parseWikiRunIndexEvent((event as MessageEvent<string>).data);
        setRuns(payload.runs);
        setConnection("live");
      } catch {
        setConnection("reconnecting");
      }
    });
    source.onerror = () => setConnection("reconnecting");
    return () => source.close();
  }, [id]);

  const startRun = async () => {
    if (!id || starting) return;
    if (!workspace?.orchestration.maxActiveRuns || !workspace.orchestration.maxConcurrentAttempts) {
      notifyError(t.validation.runCapacity);
      return;
    }
    setStarting(true);
    try {
      const receipt = await dispatchWikiRunCommand(id, {
        type: "start_run",
        commandId: newCommandId(),
        intent: {
          mode: "generate",
          ...(objective.trim() ? { objective: objective.trim() } : {}),
        },
      });
      navigate(`/w/${encodeURIComponent(id)}/runs/${encodeURIComponent(receipt.receipt.runId)}`);
    } catch (nextError) {
      notifyError(nextError);
    } finally {
      setStarting(false);
    }
  };

  if (loading) return <LoadingState />;

  return (
    <WorkbenchShell workspaceId={id} workspaceName={workspace?.name} mode="operate" immersive>
      <main
        className="flex min-h-0 flex-1 flex-col bg-background"
        data-testid="run-workspace-index"
      >
        <section className="grid shrink-0 gap-4 border-b border-border px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Radio
                className={`size-3 ${statusToneTextClass(describeConnectionStatus(connection).tone)}`}
              />
              <span>{connection === "live" ? "Live index" : "Reconnecting"}</span>
            </div>
            <h2 className="mt-1 text-lg font-semibold">Runs</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {runs.length} durable {runs.length === 1 ? "Run" : "Runs"} in this workspace.
            </p>
          </div>
          <div className="flex items-start gap-2 lg:justify-end">
            <Button
              variant="outline"
              size="icon"
              onClick={() => void refresh().catch(notifyError)}
              aria-label="Refresh Runs"
              title="Refresh Runs"
            >
              <RefreshCw />
            </Button>
            <Button onClick={() => void startRun()} disabled={starting}>
              <Plus data-icon="inline-start" />
              Start Run
            </Button>
          </div>
        </section>

        {loadError ? <ErrorBanner error={loadError} onDismiss={() => setLoadError(null)} /> : null}

        <section className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-h-0 overflow-y-auto">
            {runs.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center px-6 text-sm text-muted-foreground">
                No Runs yet.
              </div>
            ) : (
              <div className="divide-y divide-border" role="list">
                {runs.map((run) => (
                  <Link
                    key={run.runId}
                    to={`/w/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`}
                    className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 no-underline transition-colors hover:bg-muted/50 lg:px-6"
                    data-testid={`run-index-row-${run.runId}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {run.runId}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className={stateColor(run.state)}>{stateLabel(run.state)}</span>
                        <span className="text-muted-foreground">
                          {run.completedNodes}/{run.totalNodes} stages
                        </span>
                        {run.attention !== "none" ? (
                          <span className={statusToneTextClass("warning")}>{run.attention}</span>
                        ) : null}
                      </div>
                    </div>
                    <time className="self-start text-xs text-muted-foreground">
                      {new Date(run.updatedAt).toLocaleString()}
                    </time>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <aside className="border-t border-border p-4 lg:border-t-0 lg:border-l">
            <label htmlFor="run-objective" className="text-sm font-medium">
              New Run
            </label>
            <Textarea
              id="run-objective"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              className="mt-2 min-h-28 resize-none"
              placeholder="Objective or operating guidance"
            />
            <Button className="mt-3 w-full" onClick={() => void startRun()} disabled={starting}>
              <Play data-icon="inline-start" />
              {starting ? "Starting" : "Start Run"}
            </Button>
            <div className="mt-5 space-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
              <div>Active Run capacity: {workspace?.orchestration.maxActiveRuns ?? "not set"}</div>
              <div>
                Attempt capacity: {workspace?.orchestration.maxConcurrentAttempts ?? "not set"}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </WorkbenchShell>
  );
}
